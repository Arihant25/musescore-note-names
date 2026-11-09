import http.server, sys, os
# Serves the repository on http://127.0.0.1:8765 with CORS, for dev/harness.js.
root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s,*a,**k): super().__init__(*a, directory=root, **k)
    def end_headers(s):
        s.send_header('Access-Control-Allow-Origin','*')
        s.send_header('Access-Control-Allow-Private-Network','true')
        s.send_header('Cache-Control','no-store')
        super().end_headers()
    def do_OPTIONS(s):
        s.send_response(204); s.end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
