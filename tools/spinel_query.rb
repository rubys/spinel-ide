# spinel_query.rb -- the query core spinel-mcp and spinel-lsp share.
#
# Runs the spinel compiler as a subprocess on a program and turns its
# --emit-types JSON, --emit-rbs text and -S output into questions an editor
# or an agent asks: the type at a position, the diagnostics, the inferred
# signatures, the C a method compiled to. Nothing here reaches into the
# compiler; the contract is what `spinel` prints, and every answer's
# precision is that of `--emit-types` (a start position per node, no end).
#
# Written in the spinel subset so the tracker can compile it with spinel
# (`spinel tools/spinel-mcp.rb -o spinel-mcp`), and plain enough that
# `ruby tools/spinel-mcp.rb` runs the same code with no compile step.
require "json"

module SpinelQuery
  # A parsed analysis of one program.
  class Snapshot
    attr_reader :entry, :types, :diagnostics, :rbs, :c, :stderr, :rc, :elapsed_ms

    def initialize(entry, types, diagnostics, rbs, c, stderr, rc, elapsed_ms, sources)
      @entry = entry
      @types = types              # [{ "file", "line" (1-based), "col" (0-based), "type", "rbs" }]
      @diagnostics = diagnostics  # [{ "file", "line", "col", "severity", "message" }]
      @rbs = rbs                  # the --emit-rbs text
      @c = c                      # the -S output, "" when the compile was refused
      @stderr = stderr
      @rc = rc
      @elapsed_ms = elapsed_ms
      @sources = sources          # file -> text, for word bounds at a position
    end

    def refused?
      @rc != 0
    end

    def errors
      @diagnostics.select { |d| d["severity"] == "error" }
    end

    def warnings
      @diagnostics.select { |d| d["severity"] == "warning" }
    end

    # The word under a 0-based column in a line, with Ruby's ivar/gvar sigils
    # kept: spinel stamps `@x` at its `@`. Returns [start_col, end_col) or nil.
    def word_at(text, col)
      return nil if text.nil? || col < 0 || col > text.length
      s = col
      s += 1 while s < text.length && (text[s] == "@" || text[s] == "$")   # cursor on the sigil itself
      e = s
      s -= 1 while s > 0 && word_char?(text[s - 1])
      e += 1 while e < text.length && word_char?(text[e])
      s -= 1 while s > 0 && (text[s - 1] == "@" || text[s - 1] == "$")
      return nil if s == e
      [s, e]
    end

    # Types for the word at (file, 1-based line, 0-based col): the entries
    # that start inside the word, innermost first, distinct. Empty when
    # nothing starts there.
    def type_at(file, line, col)
      text = line_text(file, line)
      bounds = word_at(text, col)
      return [] if bounds.nil?
      hits = @types.select { |t| same_file?(t["file"], file) && t["line"] == line && t["col"] >= bounds[0] && t["col"] < bounds[1] }
      return [] if hits.empty?
      max_col = hits.map { |t| t["col"] }.max
      out = []
      hits.select { |t| t["col"] == max_col }.reverse.each do |t|
        out << t["rbs"] unless out.include?(t["rbs"])
      end
      out
    end

    # [start_col, end_col) of the word at a position, for a hover range.
    def word_range(file, line, col)
      word_at(line_text(file, line), col)
    end

    # The --emit-rbs text as records: one per method, with its class, the
    # signature, and whether spinel marked it a slow path. Ivars come along
    # as { "class", "ivar", "type" } records too.
    def signatures
      out = []
      cls = nil
      @rbs.each_line do |raw|
        line = raw.chomp
        if line =~ /\A(class|module) (\S+)/
          cls = $2
        elsif line =~ /\A\s+def (self\.)?([^:\s]+): (.*?)(\s*# spinel: (.*))?\z/
          out << { "class" => cls, "method" => ($1 ? "self." : "") + $2, "signature" => $3.strip, "slow" => !$5.nil?, "note" => $5 }
        elsif line =~ /\A\s+(@\w+): (.*)\z/
          out << { "class" => cls, "ivar" => $1, "type" => $2.strip }
        end
      end
      out
    end

    # The C function(s) a method compiled to: `Class#meth` or `Class.meth`
    # or a bare top-level `meth`. spinel names them sp_<Class>_<meth> and
    # sp_<meth>, with a singleton as sp_<Class>_s_<meth>. Returns the text
    # of each matching definition (declaration lines skipped).
    def c_for(name)
      return [] if @c.empty?
      sym = c_symbol(name)
      out = []
      lines = @c.lines
      i = 0
      while i < lines.length
        l = lines[i]
        if l =~ /\b#{Regexp.escape(sym)}\(/ && l !~ /;\s*\z/ && l =~ /\{\s*\z/
          j = i
          body = []
          depth = 0
          while j < lines.length
            body << lines[j]
            depth += lines[j].count("{") - lines[j].count("}")
            j += 1
            break if depth <= 0
          end
          out << body.join
          i = j
        else
          i += 1
        end
      end
      out
    end

    def c_symbol(name)
      if name =~ /\A(\w+)\.(\w+)\z/
        "sp_#{$1}_s_#{$2}"
      elsif name =~ /\A(\w+)#(\w+)\z/
        "sp_#{$1}_#{$2}"
      else
        "sp_#{name}"
      end
    end

    def line_text(file, line)
      src = @sources[file]
      src = @sources.values.first if src.nil? && @sources.length == 1
      return nil if src.nil?
      lines = src.split("\n", -1)
      return nil if line < 1 || line > lines.length
      lines[line - 1]
    end

    private

    def word_char?(ch)
      ch =~ /[A-Za-z0-9_?!]/ ? true : false
    end

    def same_file?(a, b)
      a == b || File.basename(a.to_s) == File.basename(b.to_s)
    end
  end

  # Runs the compiler. `spinel` is the command: $SPINEL, else `spinel` on
  # PATH. Every analysis is a fresh set of subprocesses; nothing is cached.
  class Runner
    attr_reader :spinel

    def initialize(spinel = nil)
      @spinel = spinel || ENV["SPINEL"] || "spinel"
      @tmpdir = ENV["TMPDIR"] || "/tmp"
      @seq = 0
    end

    def version
      out, _err, _rc = run([@spinel, "--version"])
      out.strip
    end

    # Analyze the program rooted at `path`. With `text`, that buffer stands in
    # for the file on disk: it is written beside the original (a dotfile, so
    # `require_relative` from it resolves as the original's would) for the
    # duration of the compile, and the answers name the original.
    def analyze(path, text = nil)
      started = now_ms
      target = path
      temp = nil
      if text
        temp = File.join(File.dirname(path), ".spinel-query-#{Process.pid}-#{@seq += 1}-#{File.basename(path)}")
        File.write(temp, text)
        target = temp
      end
      begin
        stamp = "#{@tmpdir}/spinel-query-#{Process.pid}-#{@seq += 1}"
        types_out, types_err, types_rc = run([@spinel, target, "--emit-types", "-o", "#{stamp}.json"])
        rbs_out, _rbs_err, _rbs_rc = run([@spinel, target, "--emit-rbs", "-o", "#{stamp}.rbs"])
        c_out, _c_err, c_rc = run([@spinel, target, "-S"])
        parsed = nil
        if File.exist?("#{stamp}.json")
          begin
            parsed = JSON.parse(File.read("#{stamp}.json"))
          rescue JSON::ParserError
            parsed = nil
          end
          File.delete("#{stamp}.json")
        end
        rbs = File.exist?("#{stamp}.rbs") ? File.read("#{stamp}.rbs") : ""
        File.delete("#{stamp}.rbs") if File.exist?("#{stamp}.rbs")
        types = parsed ? parsed["types"] : []
        diags = parsed ? parsed["diagnostics"] : stderr_diagnostics(types_err, target)
        if temp
          [types, diags].each do |list|
            list.each { |e| e["file"] = path if e["file"] == temp || File.basename(e["file"].to_s) == File.basename(temp) }
          end
        end
        sources = { path => (text || (File.exist?(path) ? File.read(path) : "")) }
        Snapshot.new(path, types, diags, rbs, c_rc == 0 ? c_out : "", types_err, types_rc, now_ms - started, sources)
      ensure
        File.delete(temp) if temp && File.exist?(temp)
      end
    end

    # `spinel: FILE:LINE: message` lines when no JSON was written (a parse
    # failure stops before --emit-types has anything to write).
    def stderr_diagnostics(err, file)
      out = []
      err.each_line do |l|
        if l =~ /\Aspinel: (?:(.+?):(\d+): )?(.*)\z/
          next if $3 =~ /\A\d+ refusals?\z/
          out << { "file" => $1 || file, "line" => $2 ? $2.to_i : 1, "col" => 0, "severity" => "error", "message" => $3.chomp }
        end
      end
      out
    end

    # Run a command, capturing stdout through a pipe and stderr through a
    # file (two pipes read in sequence can deadlock when the second fills).
    # The shell wrapper is the portable spawn, as in spinel's own `spin`.
    def run(argv)
      errfile = "#{@tmpdir}/spinel-query-#{Process.pid}-#{@seq += 1}.err"
      cmd = argv.map { |a| shell_quote(a) }.join(" ") + " 2>" + shell_quote(errfile)
      rd, wr = IO.pipe
      pid = Process.spawn("/bin/sh", "-c", cmd, :out => wr)
      wr.close
      out = rd.read
      rd.close
      _pid, status = Process.waitpid2(pid)
      err = File.exist?(errfile) ? File.read(errfile) : ""
      File.delete(errfile) if File.exist?(errfile)
      [out, err, status.exitstatus || 1]
    end

    def shell_quote(s)
      "'" + s.gsub("'", "'\\\\''") + "'"
    end

    def now_ms
      (Process.clock_gettime(Process::CLOCK_MONOTONIC) * 1000).to_i
    end
  end
end
