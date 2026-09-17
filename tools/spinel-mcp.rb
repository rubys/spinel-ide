# spinel-mcp -- spinel's compile-time answers as MCP tools for an agent.
#
#   ruby tools/spinel-mcp.rb [root]          # or the binary spinel compiles
#
# JSON-RPC 2.0 over stdio, newline-delimited (MCP's stdio transport), and
# stateless: an agent edits files with its own tools and then asks, so
# every call re-runs the compiler on what is on disk. The root is argv[1],
# else $SPINEL_ROOT, else the working directory; a relative `file` in a
# tool call resolves against it. The compiler is $SPINEL, else `spinel` on
# PATH.
#
# What the tools answer is exactly what `spinel --emit-types`, `--emit-rbs`
# and `-S` say (see spinel_query.rb); an agent with a shell could run those
# itself, and this is the structured form of doing so.
require "json"
require_relative "spinel_query"

module SpinelMCP
  PROTOCOL_VERSION = "2025-06-18"

  TOOLS = [
    { "name" => "diagnostics",
      "description" => "Compile a program with spinel and report every diagnostic: refusals (constructs spinel does not compile, severity error) and widenings (a parameter or return that fell to untyped, the boxed slow path; severity warning). Positions are 1-based lines and 0-based columns.",
      "inputSchema" => { "type" => "object", "properties" => { "file" => { "type" => "string", "description" => "the program's entry file" } }, "required" => ["file"] } },
    { "name" => "wont_compile",
      "description" => "Only the refusals: what in this program spinel will not compile, with the message naming the construct. Empty means the program compiles.",
      "inputSchema" => { "type" => "object", "properties" => { "file" => { "type" => "string" } }, "required" => ["file"] } },
    { "name" => "type_at",
      "description" => "The type spinel inferred for the name at a position (1-based line, 0-based column), as RBS. Several types mean nested expressions start at that word; the innermost is first. `untyped` is the boxed slow path.",
      "inputSchema" => { "type" => "object", "properties" => { "file" => { "type" => "string" }, "line" => { "type" => "integer" }, "column" => { "type" => "integer" } }, "required" => ["file", "line", "column"] } },
    { "name" => "signatures",
      "description" => "The inferred signatures of every method and instance variable, as RBS, with each method marked fast (typed C) or slow (a slot widened to untyped). Optionally only one class.",
      "inputSchema" => { "type" => "object", "properties" => { "file" => { "type" => "string" }, "class" => { "type" => "string", "description" => "restrict to this class" } }, "required" => ["file"] } },
    { "name" => "c_for",
      "description" => "The C spinel emitted for one method: `Class#method`, `Class.method` or a bare top-level `method`. For reading what a slot's type made the compiler do (a boxed sp_RbVal parameter, a dispatch switch); not human-friendly.",
      "inputSchema" => { "type" => "object", "properties" => { "file" => { "type" => "string" }, "method" => { "type" => "string" } }, "required" => ["file", "method"] } },
    { "name" => "version",
      "description" => "The spinel compiler this server runs, and the root it resolves files against.",
      "inputSchema" => { "type" => "object", "properties" => {} } },
  ]

  class Server
    def initialize(root, runner)
      @root = root
      @runner = runner
    end

    def serve(input, output)
      while (line = input.gets)
        line = line.strip
        next if line.empty?
        msg = nil
        begin
          msg = JSON.parse(line)
        rescue JSON::ParserError
          output.puts(JSON.generate({ "jsonrpc" => "2.0", "id" => nil, "error" => { "code" => -32700, "message" => "parse error" } }))
          output.flush
          next
        end
        response = handle(msg)
        if response
          output.puts(JSON.generate(response))
          output.flush
        end
      end
    end

    # nil for a notification (no id), else the response object.
    def handle(msg)
      id = msg["id"]
      method = msg["method"].to_s
      params = msg["params"] || {}
      if method == "initialize"
        result = {
          "protocolVersion" => params["protocolVersion"] || PROTOCOL_VERSION,
          "capabilities" => { "tools" => {} },
          "serverInfo" => { "name" => "spinel-mcp", "version" => "0.1" },
        }
        return reply(id, result)
      end
      return nil if method.start_with?("notifications/")
      return reply(id, {}) if method == "ping"
      return reply(id, { "tools" => TOOLS }) if method == "tools/list"
      if method == "tools/call"
        name = params["name"].to_s
        args = params["arguments"] || {}
        begin
          text = call_tool(name, args)
          return reply(id, { "content" => [{ "type" => "text", "text" => text }], "isError" => false })
        rescue ToolError => e
          return reply(id, { "content" => [{ "type" => "text", "text" => e.message }], "isError" => true })
        end
      end
      return nil if id.nil?
      { "jsonrpc" => "2.0", "id" => id, "error" => { "code" => -32601, "message" => "method not found: #{method}" } }
    end

    def reply(id, result)
      { "jsonrpc" => "2.0", "id" => id, "result" => result }
    end

    class ToolError < StandardError; end

    def call_tool(name, args)
      return "#{@runner.version}\nroot: #{@root}" if name == "version"
      file = resolve(args["file"])
      snap = @runner.analyze(file)
      case name
      when "diagnostics"
        render_diagnostics(snap, snap.diagnostics, file)
      when "wont_compile"
        errs = snap.errors
        errs.empty? ? "compiles: no refusals (#{snap.warnings.length} widening warning(s))" : render_diagnostics(snap, errs, file)
      when "type_at"
        line = args["line"].to_i
        col = args["column"].to_i
        types = snap.type_at(file, line, col)
        range = snap.word_range(file, line, col)
        if types.empty?
          "no typed node starts at #{rel(file)}:#{line}:#{col}" + (range ? " (word #{snap.line_text(file, line)[range[0]...range[1]]})" : "")
        else
          word = snap.line_text(file, line)[range[0]...range[1]]
          "#{rel(file)}:#{line}:#{range[0]} `#{word}`: " + types.join(" | ")
        end
      when "signatures"
        sigs = snap.signatures
        sigs = sigs.select { |s| s["class"] == args["class"] } if args["class"]
        return "no methods or instance variables inferred" if sigs.empty?
        lines = []
        cls = nil
        sigs.each do |s|
          if s["class"] != cls
            cls = s["class"]
            lines << "#{cls}:"
          end
          if s["ivar"]
            lines << "  #{s['ivar']}: #{s['type']}"
          else
            lines << "  #{s['method']}: #{s['signature']}  [#{s['slow'] ? 'slow: ' + s['note'].to_s : 'fast'}]"
          end
        end
        lines.join("\n")
      when "c_for"
        raise ToolError, "the compile was refused, nothing was emitted:\n" + render_diagnostics(snap, snap.errors, file) if snap.c.empty?
        defs = snap.c_for(args["method"].to_s)
        raise ToolError, "no C function for #{args['method']} (looked for #{snap.c_symbol(args['method'].to_s)})" if defs.empty?
        defs.join("\n")
      else
        raise ToolError, "unknown tool: #{name}"
      end
    end

    def render_diagnostics(snap, list, file)
      head = "#{rel(file)}: #{snap.errors.length} refusal(s), #{snap.warnings.length} widening(s), analyzed in #{snap.elapsed_ms} ms"
      return head + "\n(no diagnostics)" if list.empty?
      head + "\n" + list.map { |d| "#{d['severity']}: #{rel(d['file'])}:#{d['line']}:#{d['col']}: #{d['message']}" }.join("\n")
    end

    def resolve(file)
      raise ToolError, "file is required" if file.nil? || file.to_s.empty?
      path = file.to_s.start_with?("/") ? file.to_s : File.join(@root, file.to_s)
      raise ToolError, "no such file: #{path}" unless File.exist?(path)
      path
    end

    def rel(path)
      p = path.to_s
      p.start_with?(@root + "/") ? p[(@root.length + 1)..-1] : p
    end
  end
end

# No `if __FILE__ == $0` guard: in a spinel-compiled binary __FILE__ is the
# source path and $0 the binary's, so the idiom is false there (CRuby: true).
root = ARGV[0] || ENV["SPINEL_ROOT"] || Dir.pwd
root = File.expand_path(root)
$stdout.sync = true
SpinelMCP::Server.new(root, SpinelQuery::Runner.new).serve($stdin, $stdout)
