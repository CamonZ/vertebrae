"""Serve a built fixture and save benchmark results; loopback only."""
import http.server
import json
import pathlib
import sys

output = pathlib.Path(sys.argv[2]).resolve()
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=sys.argv[1], **kwargs)
    def send_head(self):
        if 'If-Modified-Since' in self.headers:
            del self.headers['If-Modified-Since']
        return super().send_head()
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def do_POST(self):
        if self.path != '/results':
            self.send_error(404)
            return
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        output.write_text(json.dumps(data, indent=2) + '\n')
        self.send_response(200)
        self.end_headers()
http.server.HTTPServer(('127.0.0.1', 18420), Handler).serve_forever()
