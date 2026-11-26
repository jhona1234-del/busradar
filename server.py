#!/usr/bin/env python3
import http.server
import json
import math
import os
import re
import shutil
import socket
import subprocess
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

PORT = 8000
ADB_PATH = r"C:\Users\Jhonatan\AppData\Local\Android\Sdk\platform-tools\adb.exe"
if not os.path.exists(ADB_PATH):
    ADB_PATH = shutil.which("adb") or "adb"
BASE_WS_URL = "http://mpa.siumobile.com.br:6060/siumobile-ws-v01/rest/ws"
WORKSPACE = os.path.dirname(os.path.abspath(__file__))

CACHE_ITI_STOPS = {}
CACHE_ITI_ROUTE = {}
CACHE_STOP_LINES = {}

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000  # meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def fetch_jsonp(url, timeout=6):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode('utf-8', errors='ignore').strip()
            m = re.search(r'^[a-zA-Z0-9_]+\((.*)\);?$', text, re.DOTALL)
            if m:
                return json.loads(m.group(1))
            return json.loads(text)
    except Exception as e:
        return {"sucesso": False, "erro": str(e)}

def get_nearby_stops(lat, lng, city="POA"):
    url = f"{BASE_WS_URL}/V3/buscarParadasProximas/{lng}/{lat}/0/{city}/retornoJSONH"
    res = fetch_jsonp(url)
    return res.get("paradas", []) if res.get("sucesso") else []

def get_stop_forecasts(cod_parada, city="POA"):
    url = f"{BASE_WS_URL}/V3/buscarPrevisoes/{cod_parada}/false/0/{city}/retornoJSON"
    res = fetch_jsonp(url)
    return res.get("previsoes", []) if res.get("sucesso") else []

def get_stop_lines(cod_parada):
    if cod_parada in CACHE_STOP_LINES:
        return CACHE_STOP_LINES[cod_parada]
    url = f"{BASE_WS_URL}/retornaLinhasQueAtendemParada/{cod_parada}/0/retornoJSON"
    res = fetch_jsonp(url)
    lines = res.get("linhas", []) if res.get("sucesso") else []
    CACHE_STOP_LINES[cod_parada] = lines
    return lines

def get_vehicles(cod_iti, city="POA"):
    url = f"{BASE_WS_URL}/V3/retornaVeiculosMapa/{cod_iti}/0/{city}/retornoJSONVeiculos"
    res = fetch_jsonp(url)
    return res.get("veiculos", []) if res.get("sucesso") else []

def get_itinerary_stops(cod_iti):
    if cod_iti in CACHE_ITI_STOPS:
        return CACHE_ITI_STOPS[cod_iti]
    url = f"{BASE_WS_URL}/buscarParadasPorItiComCoordenadas/{cod_iti}/0/retornoJSONPontosItinerario"
    res = fetch_jsonp(url)
    paradas = res.get("paradas", []) if res.get("sucesso") else []
    CACHE_ITI_STOPS[cod_iti] = paradas
    return paradas

def get_itinerary_route(cod_iti, city="POA"):
    if cod_iti in CACHE_ITI_ROUTE:
        return CACHE_ITI_ROUTE[cod_iti]
    url = f"{BASE_WS_URL}/V3/buscarItinerario/{cod_iti}/0/{city}/retornoJSONItinerario"
    res = fetch_jsonp(url)
    points = res.get("itinerarios", []) if res.get("sucesso") else []
    CACHE_ITI_ROUTE[cod_iti] = points
    return points

class RequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/api/log":
            content_len = int(self.headers.get('Content-Length', 0))
            post_body = self.rfile.read(content_len).decode('utf-8', errors='ignore')
            doc_log_path = os.path.join(os.path.expanduser("~"), "Documents", "BusRadar_log.txt")
            try:
                import time
                with open(doc_log_path, "a", encoding="utf-8") as f:
                    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
                    f.write(f"[{timestamp}] [WEB_LOG] {post_body}\n")
            except Exception:
                pass
            return self.send_json({"ok": True})
        if path == "/api/adb/connect":
            if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
                return self.send_json({"ok": False, "erro": "Acesso restrito ao host local"}, 403)
            content_len = int(self.headers.get('Content-Length', 0))
            post_body = self.rfile.read(content_len).decode('utf-8', errors='ignore')
            try:
                payload = json.loads(post_body or "{}")
            except Exception:
                return self.send_json({"ok": False, "erro": "JSON inválido"}, 400)
            host = str(payload.get("host", "")).strip()
            if not re.fullmatch(r'[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5}', host):
                return self.send_json({"ok": False, "erro": "Formato inválido. Use IP:Porta (ex: 192.168.100.50:5555)"}, 400)
            try:
                proc = subprocess.run([ADB_PATH, "connect", host], capture_output=True, text=True, timeout=20)
                out = (proc.stdout + "\n" + proc.stderr).strip()
                return self.send_json({"ok": "connected" in out.lower(), "output": out})
            except Exception as e:
                return self.send_json({"ok": False, "erro": str(e)}, 500)
        if path == "/api/adb/install":
            if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
                return self.send_json({"ok": False, "erro": "Acesso restrito ao host local"}, 403)
            apk_file = os.path.join(WORKSPACE, "BusRadar.apk")
            if not os.path.exists(apk_file):
                return self.send_json({"ok": False, "erro": "BusRadar.apk não encontrado"}, 404)
            try:
                proc = subprocess.run([ADB_PATH, "install", "-r", "-d", apk_file], capture_output=True, text=True, timeout=35)
                out = (proc.stdout + "\n" + proc.stderr).strip()
                ok = proc.returncode == 0 and "success" in out.lower()
                return self.send_json({"ok": ok, "output": out, "erro": "" if ok else out})
            except Exception as e:
                return self.send_json({"ok": False, "erro": str(e)}, 500)
        return self.send_json({"erro": "Endpoint desconhecido"}, 404)

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        # Download APK directly
        if path in ("/BusRadar.apk", "/BusRadar-SIU.apk"):
            apk_file = os.path.join(WORKSPACE, "BusRadar.apk")
            if not os.path.exists(apk_file):
                apk_file = os.path.join(WORKSPACE, "BusRadar-SIU.apk")
            if os.path.exists(apk_file):
                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.android.package-archive')
                self.send_header('Content-Disposition', 'attachment; filename="BusRadar.apk"')
                self.send_header('Content-Length', str(os.path.getsize(apk_file)))
                self.end_headers()
                with open(apk_file, 'rb') as f:
                    self.wfile.write(f.read())
                return
            else:
                return self.send_json({"erro": "APK não encontrado"}, 404)

        # PROXY ENDPOINT (Permite chamadas CORS no navegador direto ao SIU)
        if path == "/proxy":
            target_url = qs.get("url", [None])[0]
            if not target_url:
                return self.send_json({"erro": "url obrigatoria"}, 400)
            try:
                req = urllib.request.Request(target_url, headers={'User-Agent': 'okhttp/4.9.0'})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    raw = resp.read().decode('utf-8', errors='ignore').strip()
                    m = re.search(r'^[a-zA-Z0-9_]+\((.*)\);?$', raw, re.DOTALL)
                    clean_json = m.group(1) if m else raw
                    body = clean_json.encode('utf-8')
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
            except Exception as e:
                self.send_json({"sucesso": False, "erro": str(e)}, 500)
            return

        if path.startswith("/api/"):
            city = qs.get("city", ["POA"])[0]

            if path == "/api/version":
                v_file = os.path.join(WORKSPACE, "static", "version.json")
                if not os.path.exists(v_file):
                    v_file = os.path.join(WORKSPACE, "version.json")
                if os.path.exists(v_file):
                    try:
                        with open(v_file, "r", encoding="utf-8") as vf:
                            data = json.load(vf)
                        return self.send_json({
                            "ok": True,
                            "versionCode": int(data.get("versionCode", 0)),
                            "versionName": str(data.get("versionName", "")),
                            "apkUrl": "/BusRadar.apk"
                        })
                    except Exception as e:
                        return self.send_json({"ok": False, "erro": str(e)}, 500)
                return self.send_json({"ok": False, "erro": "version.json nao encontrado"}, 404)

            if path == "/api/adb/status":
                if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
                    return self.send_json({"ok": False, "devices": []}, 403)
                try:
                    proc = subprocess.run([ADB_PATH, "devices"], capture_output=True, text=True, timeout=25)
                    devs = []
                    for ln in (proc.stdout or "").splitlines()[1:]:
                        parts = ln.strip().split()
                        if len(parts) >= 2 and parts[1] == "device":
                            devs.append(parts[0])
                    return self.send_json({"ok": True, "devices": devs})
                except Exception as e:
                    return self.send_json({"ok": False, "devices": [], "erro": str(e)}, 500)

            if path == "/api/stops/nearby":
                lat = qs.get("lat", [None])[0]
                lng = qs.get("lng", [None])[0]
                radius = float(qs.get("radius", [1200])[0])
                if not lat or not lng:
                    return self.send_json({"erro": "lat e lng obrigatorios"}, 400)
                
                raw_stops = get_nearby_stops(lat, lng, city)
                c_lat, c_lng = float(lat), float(lng)
                filtered = []
                for s in raw_stops:
                    dist = haversine_m(c_lat, c_lng, float(s["y"]), float(s["x"]))
                    s["distance_m"] = round(dist)
                    if dist <= radius:
                        filtered.append(s)
                
                return self.send_json({"stops": filtered})

            elif path == "/api/stop/details":
                cod = qs.get("cod", [None])[0]
                if not cod:
                    return self.send_json({"erro": "cod obrigatorio"}, 400)
                with ThreadPoolExecutor(max_workers=2) as ex:
                    f_lines = ex.submit(get_stop_lines, cod)
                    f_prevs = ex.submit(get_stop_forecasts, cod, city)
                    lines = f_lines.result()
                    prevs = f_prevs.result()
                return self.send_json({"lines": lines, "forecasts": prevs})

            elif path == "/api/itinerary/stops":
                cod_iti = qs.get("codIti", [None])[0]
                if not cod_iti:
                    return self.send_json({"erro": "codIti obrigatorio"}, 400)
                stops = get_itinerary_stops(cod_iti)
                return self.send_json({"paradas": stops})

            elif path == "/api/itinerary/route":
                cod_iti = qs.get("codIti", [None])[0]
                if not cod_iti:
                    return self.send_json({"erro": "codIti obrigatorio"}, 400)
                route = get_itinerary_route(cod_iti, city)
                stops = get_itinerary_stops(cod_iti)
                return self.send_json({"route": route, "stops": stops})

            elif path == "/api/buses/around":
                lat = qs.get("lat", [None])[0]
                lng = qs.get("lng", [None])[0]
                if not lat or not lng:
                    return self.send_json({"erro": "lat e lng obrigatorios"}, 400)

                raw_stops = get_nearby_stops(lat, lng, city)[:6]
                active_itis = set()
                with ThreadPoolExecutor(max_workers=6) as ex:
                    futures = [ex.submit(get_stop_forecasts, s["cod"], city) for s in raw_stops]
                    for f in futures:
                        try:
                            fcs = f.result()
                            for fc in fcs:
                                if fc.get("codItinerario"):
                                    active_itis.add(fc["codItinerario"])
                        except Exception:
                            pass

                all_veics = []
                seen_veics = set()
                with ThreadPoolExecutor(max_workers=8) as ex:
                    v_futures = {ex.submit(get_vehicles, iti, city): iti for iti in list(active_itis)[:12]}
                    for f in v_futures:
                        iti = v_futures[f]
                        try:
                            v_list = f.result()
                            for v in v_list:
                                vid = v.get("numVeicGestor") or f"{v.get('lat')}_{v.get('long')}"
                                if vid not in seen_veics:
                                    seen_veics.add(vid)
                                    all_veics.append({**v, "codIti": iti})
                        except Exception:
                            pass

                return self.send_json({"veiculos": all_veics, "count": len(all_veics)})

            elif path == "/api/match":
                orig_lat = float(qs.get("origLat", [0])[0])
                orig_lng = float(qs.get("origLng", [0])[0])
                dest_lat = float(qs.get("destLat", [0])[0])
                dest_lng = float(qs.get("destLng", [0])[0])
                dest_radius = float(qs.get("destRadius", [1200])[0])
                orig_radius = float(qs.get("origRadius", [1200])[0])

                if not orig_lat or not orig_lng or not dest_lat or not dest_lng:
                    return self.send_json({"erro": "origLat, origLng, destLat, destLng obrigatorios"}, 400)

                with ThreadPoolExecutor(max_workers=2) as ex:
                    f_orig = ex.submit(get_nearby_stops, orig_lat, orig_lng, city)
                    f_dest = ex.submit(get_nearby_stops, dest_lat, dest_lng, city)
                    all_orig_stops = f_orig.result()
                    all_dest_stops = f_dest.result()

                dest_stops = []
                for s in all_dest_stops:
                    dist = haversine_m(dest_lat, dest_lng, float(s["y"]), float(s["x"]))
                    s["distance_to_dest_m"] = round(dist)
                    if dist <= dest_radius:
                        dest_stops.append(s)

                orig_stops = []
                for s in all_orig_stops:
                    dist = haversine_m(orig_lat, orig_lng, float(s["y"]), float(s["x"]))
                    s["distance_to_orig_m"] = round(dist)
                    if dist <= orig_radius:
                        orig_stops.append(s)

                dest_stop_codes = {s["cod"] for s in dest_stops}
                dest_stops_by_cod = {s["cod"]: s for s in dest_stops}

                orig_forecasts = []
                def get_orig_fc(st):
                    return st, get_stop_forecasts(st["cod"], city)

                with ThreadPoolExecutor(max_workers=8) as ex:
                    futures = [ex.submit(get_orig_fc, s) for s in orig_stops[:10]]
                    for f in futures:
                        try:
                            st, fcs = f.result()
                            for fc in fcs:
                                orig_forecasts.append({"orig_stop": st, **fc})
                        except Exception:
                            pass

                unique_itis = {fc["codItinerario"] for fc in orig_forecasts if fc.get("codItinerario")}
                iti_stops_map = {}

                with ThreadPoolExecutor(max_workers=8) as ex:
                    futures = {ex.submit(get_itinerary_stops, iti): iti for iti in unique_itis}
                    for f in futures:
                        iti = futures[f]
                        try:
                            iti_stops_map[iti] = f.result()
                        except Exception:
                            iti_stops_map[iti] = []

                matched_buses = []
                matched_itis = set()

                for item in orig_forecasts:
                    iti = item.get("codItinerario")
                    orig_cod = item["orig_stop"]["cod"]
                    stops_seq = iti_stops_map.get(iti, [])
                    if not stops_seq:
                        continue

                    orig_idx = None
                    dest_match = None
                    for idx, st in enumerate(stops_seq):
                        if st["cod"] == orig_cod and orig_idx is None:
                            orig_idx = idx
                        elif orig_idx is not None and st["cod"] in dest_stop_codes:
                            dest_match = dest_stops_by_cod.get(st["cod"], st)
                            break

                    if orig_idx is not None and dest_match is not None:
                        matched_itis.add(iti)
                        matched_buses.append({
                            **item,
                            "dest_stop": dest_match
                        })

                vehicles_map = {}
                with ThreadPoolExecutor(max_workers=8) as ex:
                    v_futures = {ex.submit(get_vehicles, iti, city): iti for iti in matched_itis}
                    for f in v_futures:
                        iti = v_futures[f]
                        try:
                            veics = f.result()
                            for v in veics:
                                v["codItinerario"] = iti
                            vehicles_map[iti] = veics
                        except Exception:
                            vehicles_map[iti] = []

                return self.send_json({
                    "orig_stops": orig_stops,
                    "dest_stops": dest_stops,
                    "matches": matched_buses,
                    "vehicles": vehicles_map,
                    "dest_radius_m": dest_radius
                })

            else:
                return self.send_json({"erro": "Endpoint desconhecido"}, 404)

        if path == "/":
            self.path = "/static/index.html"
        elif not path.startswith("/static/"):
            self.path = "/static" + path

        return super().do_GET()

def run_server():
    os.chdir(WORKSPACE)
    server_address = ('', PORT)
    httpd = http.server.ThreadingHTTPServer(server_address, RequestHandler)
    
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
    except Exception:
        local_ip = "127.0.0.1"
    finally:
        s.close()

    print(f"=====================================================")
    print(f"  [+] BusRadar Rodando!")
    print(f"  [>] Local (PC):       http://localhost:{PORT}")
    print(f"  [>] Celular (WiFi):   http://{local_ip}:{PORT}")
    print(f"  [>] Download do APK:  http://{local_ip}:{PORT}/BusRadar.apk")
    print(f"=====================================================")
    httpd.serve_forever()

if __name__ == '__main__':
    run_server()
