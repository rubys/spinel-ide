# spinel_query.rb -- the query core spinel-mcp and spinel-lsp share.
#
# Runs the spinel compiler as a subprocess on a program and turns its
# --emit-types JSON, --emit-rbs text and -S output into questions an editor
# or an agent asks: the type at a position, the diagnostics, the inferred
# signatures, the C a method compiled to. Nothing here reaches into the
# compiler; the contract is what `spinel` prints. Since matz/spinel#4522
# every record carries a span, a kind and a name, a widening names its
# slot, and a `codegen` array says what codegen decided at each call and
# block; since 62a176b1 a `DefNode` record carries the method's `owner` and
# `signature` (docs/emit-types.md). An older spinel without those falls
# back to a start position and the word under the cursor, and places no
# signatures.
#
# Written in the spinel subset so the tracker can compile it with spinel
# (`spinel tools/spinel-mcp.rb -o spinel-mcp`), and plain enough that
# `ruby tools/spinel-mcp.rb` runs the same code with no compile step.
require "json"

module SpinelQuery
  # A parsed analysis of one program.
  class Snapshot
    attr_reader :entry, :types, :diagnostics, :codegen, :rbs, :c, :stderr, :rc, :elapsed_ms

    def initialize(entry, types, diagnostics, rbs, c, stderr, rc, elapsed_ms, sources, codegen = [])
      @entry = entry
      @types = types              # [{ "file", "line" (1-based), "col" (0-based), "end_line", "end_col", "kind", "name", "type", "rbs" }]
                                  #   a DefNode also: "owner", "signature", "widened" (true when a slot degraded), "singleton"
      @diagnostics = diagnostics  # [{ "file", "line", "col", "end_line", "end_col", "severity", "message", "slot", "param", "method" }]
      @codegen = codegen          # [{ "file", "line", "col", "end_line", "end_col", "kind", "name", "dispatch" | "inlined" }]
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

    # The records whose span contains (1-based line, 0-based col), tightest
    # first. Records without an end never match.
    def spans_at(records, file, line, col)
      hits = records.select do |r|
        next false if r["end_line"].nil? || !same_file?(r["file"], file)
        after_start = line > r["line"] || (line == r["line"] && col >= r["col"])
        before_end = line < r["end_line"] || (line == r["end_line"] && col < r["end_col"])
        after_start && before_end
      end
      # Same span, a named node first: a block's StatementsNode covers exactly
      # the call it is the body of.
      hits.sort_by { |r| [(r["end_line"] - r["line"]) * 100000 + (r["end_col"] - r["col"]), r["name"].nil? ? 1 : 0] }
    end

    # What a hover says at a position: the tightest typed node, the calls
    # enclosing it, and the codegen decision for the call and block there.
    # nil when nothing is typed at the position. Falls back to the word
    # heuristic (type_at) when the dump has no spans.
    def hover_at(file, line, col)
      spans = spans_at(@types, file, line, col)
      if spans.empty?
        types = type_at(file, line, col)
        return nil if types.empty?
        r = word_range(file, line, col)
        return { "name" => line_text(file, line)[r[0]...r[1]], "kind" => nil, "rbs" => types.join(" | "), "range" => [line, r[0], line, r[1]], "chain" => [], "call" => nil, "block" => nil, "fallback" => true }
      end
      tight = spans[0]
      chain = spans[1, 3].to_a.select { |r| r["kind"] == "CallNode" }
      decisions = spans_at(@codegen, file, line, col)
      # A def's own type is the def expression's value (a Symbol); what a
      # hover on it wants is the method type it declares.
      is_def = tight["kind"] == "DefNode" && !tight["signature"].nil?
      {
        "name" => is_def ? method_label(tight) : tight["name"], "kind" => tight["kind"],
        "rbs" => is_def ? tight["signature"] : tight["rbs"],
        "range" => [tight["line"], tight["col"], tight["end_line"], tight["end_col"]],
        "chain" => chain.map { |r| { "name" => r["name"], "rbs" => r["rbs"] } },
        "call" => decisions.find { |d| d["kind"] == "CallNode" },
        "block" => decisions.find { |d| d["kind"] == "BlockNode" },
        "fallback" => false,
      }
    end

    # The def a name at a position resolves to: for a call, the DefNode of
    # that name (in the receiver's class when the RBS names one, else any);
    # for a local or instance variable, its first write. nil when unknown
    # or when the dump has no kinds.
    def definition_at(file, line, col)
      tight = spans_at(@types, file, line, col)[0]
      return nil if tight.nil? || tight["name"].nil?
      name = tight["name"]
      case tight["kind"]
      when "CallNode"
        @types.find { |r| r["kind"] == "DefNode" && r["name"] == name }
      when "LocalVariableReadNode", "LocalVariableWriteNode"
        @types.find { |r| r["kind"] == "LocalVariableWriteNode" && r["name"] == name && same_file?(r["file"], file) }
      when /InstanceVariable/
        @types.find { |r| r["kind"] == "InstanceVariableWriteNode" && r["name"] == name }
      when "DefNode"
        tight
      else
        nil
      end
    end

    # Every record naming the same thing as the one at a position: reads,
    # writes, calls and the def, in source order.
    def references_at(file, line, col)
      tight = spans_at(@types, file, line, col)[0]
      return [] if tight.nil? || tight["name"].nil?
      name = tight["name"]
      family = if tight["kind"] =~ /LocalVariable/ then /LocalVariable/
               elsif tight["kind"] =~ /InstanceVariable/ then /InstanceVariable/
               else /\A(CallNode|DefNode)\z/
               end
      @types.select { |r| r["name"] == name && r["kind"].to_s =~ family }
            .sort_by { |r| [r["file"].to_s, r["line"], r["col"]] }
    end

    # The calls that did not take the direct path, and the blocks that
    # became functions, in source order: the codegen lens as a list.
    def slow_sites
      @codegen.select { |d| (d["kind"] == "CallNode" && d["dispatch"] != "direct") || (d["kind"] == "BlockNode" && d["inlined"] == false) }
              .sort_by { |d| [d["file"].to_s, d["line"], d["col"]] }
    end

    # Types for the word at (file, 1-based line, 0-based col): the entries
    # that start inside the word, innermost first, distinct. Empty when
    # nothing starts there. The pre-#4522 answer, kept as the fallback.
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

    # The defs the compiler placed, in source order: the DefNode records
    # that carry a `signature` (empty with an older spinel).
    def defs
      @types.select { |r| r["kind"] == "DefNode" && !r["signature"].nil? }
            .sort_by { |r| [r["file"].to_s, r["line"], r["col"]] }
    end

    # `Point#dist2`, `Point.make`, or a bare `total` at the top level, from
    # a DefNode record.
    def method_label(r)
      owner = r["owner"]
      return r["name"].to_s if owner.nil? || owner == "Object"
      owner + (r["singleton"] ? "." : "#") + r["name"].to_s
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
        codegen = parsed && parsed["codegen"] ? parsed["codegen"] : []
        if temp
          [types, diags, codegen].each do |list|
            list.each { |e| e["file"] = path if e["file"] == temp || File.basename(e["file"].to_s) == File.basename(temp) }
          end
        end
        sources = { path => (text || (File.exist?(path) ? File.read(path) : "")) }
        Snapshot.new(path, types, diags, rbs, c_rc == 0 ? c_out : "", types_err, types_rc, now_ms - started, sources, codegen)
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
