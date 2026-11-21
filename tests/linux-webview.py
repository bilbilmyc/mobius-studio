"""Exercise a packaged Linux application with WebKitGTK's native WebDriver."""
import argparse
import base64
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("video", type=Path, help="A short, valid local H.264 MP4 fixture")
    args = parser.parse_args()
    clip = args.video.read_bytes()
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQqHkGAAJaAYvrcg4EAAAAAElFTkSuQmCC")
    calls = []

    class Relay(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, data, self.headers.get("x-api-key")))
            body = json.dumps({"data": {"url": f"http://127.0.0.1:{self.server.server_port}/result.mp4"}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            assert self.path == "/result.mp4" and not self.headers.get("x-api-key")
            self.send_response(200)
            self.send_header("Content-Length", str(len(clip)))
            self.end_headers()
            self.wfile.write(clip)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Relay)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = free_port()
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(method, route, body=None):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{route}", method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
        try:
            with client.open(req, timeout=30) as r:
                return json.load(r)["value"]
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode()[:900]) from error

    with tempfile.TemporaryDirectory(prefix="mobius-webkit-") as directory:
        home = Path(directory)
        first = home / "start.png"
        first.write_bytes(png)
        env = dict(os.environ, TAURI_WEBVIEW_AUTOMATION="true", MOBIUS_HOME=str(home / "Data"))
        driver = subprocess.Popen(["WebKitWebDriver", f"--port={port}"], env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        session = None
        try:
            for _ in range(80):
                try:
                    if request("GET", "/status")["ready"]:
                        break
                except OSError:
                    time.sleep(.1)
            caps = {"webkitgtk:browserOptions": {"binary": str(args.binary.resolve())}}
            session = "/session/" + request("POST", "/session", {"capabilities": {"alwaysMatch": caps}})["sessionId"]

            def js(script, *values):
                return request("POST", session + "/execute/sync", {"script": script, "args": list(values)})

            def async_js(script, *values):
                return request("POST", session + "/execute/async", {
                    "script": "const cb=arguments[arguments.length-1];(async()=>{" + script + "})().then(cb,e=>cb({error:String(e)}))",
                    "args": list(values)})

            for _ in range(100):
                if js("return !!window.studio && !!document.querySelector('.generate:not([disabled])')"):
                    break
                time.sleep(.1)
            assert js("return document.querySelector('.service-row select').value") == "@site"
            settings = {"auth": "x-api-key", "submit": "text", "body": "{}", "url": "data.url",
                        "sizes": ["1344x768"], "seconds": [7], "workflows": {"first_last": {
                            "submit": "transition", "encoding": "json",
                            "body": '{"first":"{{first_frame}}","last":"{{last_frame}}","width":"{{width}}","duration":"{{seconds}}"}'}}}
            profile = dict(protocol="relay-video", name="Linux 验证", key="local-test", sessionOnly=True,
                           model="webkit-test", base=f"http://127.0.0.1:{server.server_port}/v1", relay=settings)
            endpoint = async_js("return window.studio.save(arguments[0]);", profile)
            assert isinstance(endpoint, str), endpoint
            job = async_js("""
                const a=await window.studio.drop('image',[arguments[1]]);
                const b=await window.studio.link('image','https://example.invalid/tail.png');
                return window.studio.start({profileId:arguments[0],kind:'video',template:'',prompt:'Linux 首尾帧',
                size:'1344x768',seconds:7,priority:0,config:{mode:'first_last'},assets:[a[0],b]});
            """, endpoint, str(first))
            assert isinstance(job, str), job
            for _ in range(100):
                saved = async_js("return (await window.studio.state()).jobs.find(j=>j.id===arguments[0]);", job)
                if saved["status"] in ("done", "paused", "uncertain", "failed"):
                    break
                time.sleep(.1)
            assert saved["status"] == "done", saved["detail"]
            assert len(calls) == 1
            route, body, key = calls[0]
            assert route == "/v1/transition" and key == "local-test"
            assert body == {"first": "data:image/png;base64,"+base64.b64encode(png).decode(),
                            "last": "https://example.invalid/tail.png", "width": 1344, "duration": 7}
            assert Path(saved["mediaPath"]).read_bytes() == clip
            media_url=saved["mediaUrl"]
            assert media_url.startswith("http://127.0.0.1:")
            with client.open(urllib.request.Request(media_url,headers={"Range":"bytes=3-11"})) as part:
                assert part.status==206 and part.read()==clip[3:12]
            try:
                client.open(media_url.replace(media_url.split("/")[-2], "invalid"))
                raise AssertionError("A request without the session token should fail")
            except urllib.error.HTTPError as refused:
                assert refused.code==404
            js("document.querySelectorAll('.rail nav button')[1].click()")
            for _ in range(80):
                if js("return !!document.querySelector('.card video')"):
                    break
                time.sleep(.1)
            js("document.querySelector('.card').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
            for _ in range(100):
                if js("return document.querySelector('.canvas video')?.readyState>=1"):
                    break
                time.sleep(.1)
            dims = js("const v=document.querySelector('.canvas video');return v&&[v.videoWidth,v.videoHeight]")
            assert dims and min(dims) > 0, js("""const v=document.querySelector('.canvas video');return v?{source:v.currentSrc,err:v.error?.message,code:v.error?.code,state:v.readyState,network:v.networkState,mp4:v.canPlayType('video/mp4; codecs="avc1.42E01E"')}:document.querySelector('main h1')?.textContent""")
            print("Linux WebKitGTK passed: default site, authenticated relay, ordered frames, 7 s request, saved bytes and decoded video", dims)
        finally:
            if session:
                try:
                    request("DELETE", session)
                except (OSError, RuntimeError):
                    pass
            driver.terminate()
            driver.wait(timeout=10)
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
