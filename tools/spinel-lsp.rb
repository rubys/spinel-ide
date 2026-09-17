# spinel-lsp -- spinel's inference in an editor, over the Language Server
# Protocol.
#
#   ruby tools/spinel-lsp.rb          # or the binary spinel compiles
#
# Read-only: it publishes diagnostics and answers hover, inlay hints and
# code lenses; it never proposes an edit. Every open buffer is analyzed by
# running the compiler on it (spinel_query.rb writes the buffer beside the
# file so `require_relative` resolves), and a document's answers come from
# its latest analysis. The analysis is synchronous: a change is analyzed
# before the next message is read. That is fine for programs of a size
# spinel compiles in tens of milliseconds and wrong for a whole application
# (a minute); a background analysis with a last-good snapshot is the next
# step, and this MVP says so rather than pretend.
#
# What the server can say is bounded by `--emit-types`: a start position
# per node, no end, no node kind; hover resolves to the word under the
# cursor, and a widening is reported at its `def`. Columns are treated as
# characters (UTF-16 units and bytes agree for ASCII).
#
# SPINEL_LSP_LOG=<path> appends one line per message in and out (method,
# id, and for an analysis its timing and counts): what to attach to a
# report about an editor that does not show what it should.
require "json"
require_relative "spinel_query"

module SpinelLSP
  class Server
    def initialize(runner)
      @runner = runner
      @docs = {}       # uri -> text
      @snaps = {}      # uri -> Snapshot
      @shutdown = false
      @log = ENV["SPINEL_LSP_LOG"]
    end

    def log(line)
      return if @log.nil? || @log.empty?
      File.open(@log, "a") { |f| f.puts("#{Time.now.strftime('%H:%M:%S')} #{line}") }
    end

    # ---- transport: Content-Length framed JSON over stdio ----

    def serve(input, output)
      @out = output
      loop do
        msg = read_message(input)
        break if msg.nil?
        handle(msg)
        break if @exit
      end
    end

    def read_message(input)
      length = nil
      loop do
        line = input.gets
        return nil if line.nil?
        line = line.chomp
        break if line.empty?
        length = $1.to_i if line =~ /\AContent-Length:\s*(\d+)/i
      end
      return nil if length.nil?
      body = input.read(length)
      return nil if body.nil?
      JSON.parse(body)
    rescue JSON::ParserError
      {}
    end

    def send(obj)
      log("-> #{obj['method'] || 'response'} id=#{obj['id'].inspect}#{obj['error'] ? ' error=' + obj['error']['message'] : ''}")
      body = JSON.generate(obj)
      @out.write("Content-Length: #{body.bytesize}\r\n\r\n")
      @out.write(body)
      @out.flush
    end

    def reply(id, result)
      send({ "jsonrpc" => "2.0", "id" => id, "result" => result })
    end

    def error(id, code, message)
      send({ "jsonrpc" => "2.0", "id" => id, "error" => { "code" => code, "message" => message } })
    end

    def notify(method, params)
      send({ "jsonrpc" => "2.0", "method" => method, "params" => params })
    end

    # ---- dispatch ----

    def handle(msg)
      id = msg["id"]
      method = msg["method"].to_s
      params = msg["params"] || {}
      log("<- #{method} id=#{id.inspect}")
      case method
      when "initialize"
        reply(id, {
          "capabilities" => {
            "textDocumentSync" => 1,        # full text on every change
            "hoverProvider" => true,
            "inlayHintProvider" => true,
            "codeLensProvider" => { "resolveProvider" => false },
          },
          "serverInfo" => { "name" => "spinel-lsp", "version" => "0.1" },
        })
      when "initialized"
        nil
      when "shutdown"
        @shutdown = true
        reply(id, nil)
      when "exit"
        @exit = true
      when "textDocument/didOpen"
        doc = params["textDocument"] || {}
        @docs[doc["uri"]] = doc["text"].to_s
        analyze(doc["uri"])
      when "textDocument/didChange"
        uri = (params["textDocument"] || {})["uri"]
        changes = params["contentChanges"] || []
        @docs[uri] = changes.last["text"].to_s unless changes.empty?
        analyze(uri)
      when "textDocument/didClose"
        uri = (params["textDocument"] || {})["uri"]
        @docs.delete(uri)
        @snaps.delete(uri)
        notify("textDocument/publishDiagnostics", { "uri" => uri, "diagnostics" => [] })
      when "textDocument/hover"
        reply(id, hover(params))
      when "textDocument/inlayHint"
        reply(id, inlay_hints(params))
      when "textDocument/codeLens"
        reply(id, code_lenses(params))
      else
        error(id, -32601, "method not found: #{method}") unless id.nil?
      end
    end

    # ---- analysis ----

    def path_of(uri)
      u = uri.to_s
      u = u[7..-1] if u.start_with?("file://")
      u.gsub("%20", " ")
    end

    def analyze(uri)
      text = @docs[uri]
      return if text.nil?
      snap = @runner.analyze(path_of(uri), text)
      @snaps[uri] = snap
      log("   analyzed #{path_of(uri)}: #{snap.types.length} types, #{snap.diagnostics.length} diagnostics, rc=#{snap.rc}, #{snap.elapsed_ms} ms")
      diags = snap.diagnostics.map do |d|
        line = [d["line"].to_i - 1, 0].max
        col = d["col"].to_i
        len = if d["severity"] == "error"
                line_length(text, line) - col
              else
                r = snap.word_range(path_of(uri), line + 1, col)
                r ? r[1] - r[0] : 3
              end
        len = 1 if len < 1
        {
          "range" => range(line, col, line, col + len),
          "severity" => d["severity"] == "error" ? 1 : 2,
          "source" => "spinel",
          "message" => d["message"],
        }
      end
      notify("textDocument/publishDiagnostics", { "uri" => uri, "diagnostics" => diags })
    end

    # ---- answers ----

    def hover(params)
      uri = (params["textDocument"] || {})["uri"]
      snap = @snaps[uri]
      return nil if snap.nil?
      pos = params["position"] || {}
      line = pos["line"].to_i + 1
      col = pos["character"].to_i
      types = snap.type_at(path_of(uri), line, col)
      return nil if types.empty?
      r = snap.word_range(path_of(uri), line, col)
      word = snap.line_text(path_of(uri), line)[r[0]...r[1]]
      value = "**#{word}** — inferred type\n\n" + types.map { |t| "`#{t}`" }.join(" · ")
      value += "\n\n_untyped: the boxed slow path_" if types.include?("untyped")
      {
        "contents" => { "kind" => "markdown", "value" => value },
        "range" => range(line - 1, r[0], line - 1, r[1]),
      }
    end

    # The inferred signature after each `def`'s parameter list: the
    # signature the author never wrote, in place.
    def inlay_hints(params)
      uri = (params["textDocument"] || {})["uri"]
      snap = @snaps[uri]
      return [] if snap.nil?
      hints = []
      each_def(@docs[uri].to_s, snap) do |line0, end_col, sig|
        hints << {
          "position" => { "line" => line0, "character" => end_col },
          "label" => " : #{sig['signature']}",
          "kind" => 1,
          "paddingLeft" => true,
          "tooltip" => sig["slow"] ? "slow path: #{sig['note']}" : "fast path: every slot typed",
        }
      end
      hints
    end

    def code_lenses(params)
      uri = (params["textDocument"] || {})["uri"]
      snap = @snaps[uri]
      return [] if snap.nil?
      lenses = []
      each_def(@docs[uri].to_s, snap) do |line0, _end_col, sig|
        title = sig["slow"] ? "slow path: #{sig['note']}" : "fast path"
        lenses << { "range" => range(line0, 0, line0, 0), "command" => { "title" => title, "command" => "" } }
      end
      lenses
    end

    # Pair each `def` line in the text with its signature record, matched by
    # method name inside the enclosing class: the nearest `class`/`module`
    # line above it with less indentation (--emit-types does not say where
    # a def is, so this is a text scan that assumes conventional layout).
    # Yields (0-based line, column after the parameter list, signature).
    def each_def(text, snap)
      sigs = snap.signatures.select { |s| s["method"] }
      lines = text.split("\n", -1)
      lines.each_with_index do |raw, i|
        next unless raw =~ /\A(\s*)def\s+(self\.)?([a-zA-Z_]\w*[?!=]?)(\s*\([^)]*\))?/
        indent = $1.length
        name = ($2 ? "self." : "") + $3
        head_end = $~.end(0)
        cls = "Object"
        j = i - 1
        while j >= 0
          if lines[j] =~ /\A(\s*)(class|module)\s+([A-Z][\w:]*)/ && $1.length < indent
            cls = $3
            break
          end
          j -= 1
        end
        sig = sigs.find { |s| s["method"] == name && s["class"] == cls } || sigs.find { |s| s["method"] == name }
        yield i, head_end, sig if sig
      end
    end

    def range(l0, c0, l1, c1)
      { "start" => { "line" => l0, "character" => c0 }, "end" => { "line" => l1, "character" => c1 } }
    end

    def line_length(text, line0)
      lines = text.split("\n", -1)
      line0 < lines.length ? lines[line0].length : 0
    end
  end
end

# No `if __FILE__ == $0` guard: false in a spinel-compiled binary.
$stdout.sync = true
SpinelLSP::Server.new(SpinelQuery::Runner.new).serve($stdin, $stdout)
