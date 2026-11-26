// BusRadar - Motor de Monitoramento e Rotas em Tempo Real v1.7
// 100% Standalone - ZERO Dependência Externa (Sem Leaflet)
(function () {
  "use strict";

  const CANOAS_CENTRO = { lat: -29.9189, lng: -51.1804 };
  const SIU_BASE = "http://mpa.siumobile.com.br:6060/siumobile-ws-v01/rest/ws";

  // Helper log function (escreve na tela, no Android e grava em Documentos/BusRadar_log.txt no PC)
  function logMsg(msg) {
    if (window.addAppLog) window.addAppLog(msg);
    if (window.AndroidBridge && window.AndroidBridge.log) {
      try {
        window.AndroidBridge.log("APP_JS", msg);
      } catch (e) {}
    } else {
      try {
        if (window.location.protocol.startsWith("http")) {
          fetch("/api/log", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: msg
          }).catch(() => {});
        }
      } catch (e) {}
    }
  }

  // --- RADARMAP: MOTOR NATIVO DE MAPA SLIPPY (ZERO-DEPENDENCY) ---
  class RadarMap {
    constructor(containerId, options = {}) {
      this.container = typeof containerId === "string" ? document.getElementById(containerId) : containerId;
      if (!this.container) throw new Error("Elemento do mapa não encontrado: " + containerId);

      this.zoom = options.zoom || 15;
      this.minZoom = 11;
      this.maxZoom = 19;
      this.center = options.center || { lat: CANOAS_CENTRO.lat, lng: CANOAS_CENTRO.lng };

      this.callbacks = {
        moveend: [],
        click: []
      };

      const savedTier = parseInt(localStorage.getItem("busradar_tile_tier") || "1", 10);
      this.tileTier = isNaN(savedTier) ? 1 : Math.min(Math.max(savedTier, 1), 6);
      this.cartoApiKey = localStorage.getItem("busradar_carto_api_key") || "";
      this.customTileUrl = localStorage.getItem("busradar_custom_tile_url") || "";
      this.tilesMap = new Map();
      this.stops = [];
      this.destStops = [];
      this.centerStops = [];
      this.routeStops = [];
      this.savedStops = [];
      this.vehicles = [];
      this.trainStations = [];
      this.trains = [];
      this.trainTrack = [];
      this.routes = new Map();
      this.userPos = null;
      this.homePos = null;
      this.homeRadius = 0;
      this.pickerPos = null;
      this.pickerTarget = null;
      this.onStopClick = null;
      this.onCenterStopClick = null;
      this.onRouteStopClick = null;
      this.onSavedStopClick = null;
      this.onBusClick = null;
      this.onTrainStationClick = null;
      this.onTrainClick = null;
      this.onUserLocClick = null;

      // Keyed DOM Maps para retenção anti-flicker e zero piscada
      this.savedStopDoms = new Map();
      this.stopDoms = new Map();
      this.routeStopDoms = new Map();
      this.centerStopDoms = new Map();
      this.vehicleDoms = new Map();
      this.trainStationDoms = new Map();
      this.trainDoms = new Map();
      this.pinDoms = new Map();

      this.initDOM();
      this.bindEvents();
      this.render();
      logMsg("RadarMap: Motor nativo iniciado com sucesso (Sem Leaflet).");
    }

    initDOM() {
      this.container.innerHTML = "";
      this.viewport = document.createElement("div");
      this.viewport.className = "rm-viewport";

      this.world = document.createElement("div");
      this.world.className = "rm-world";

      this.tileLayer = document.createElement("div");
      this.tileLayer.className = "rm-tile-layer";

      this.svgLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.svgLayer.setAttribute("class", "rm-svg-layer");

      this.markersLayer = document.createElement("div");
      this.markersLayer.className = "rm-markers-layer";

      this.trainsLayer = document.createElement("div");
      this.trainsLayer.className = "rm-sublayer rm-trains-layer";

      this.stopsLayer = document.createElement("div");
      this.stopsLayer.className = "rm-sublayer rm-stops-layer";

      this.routeStopsLayer = document.createElement("div");
      this.routeStopsLayer.className = "rm-sublayer rm-route-stops-layer";

      this.centerStopsLayer = document.createElement("div");
      this.centerStopsLayer.className = "rm-sublayer rm-center-stops-layer";

      this.savedStopsLayer = document.createElement("div");
      this.savedStopsLayer.className = "rm-sublayer rm-saved-stops-layer";

      this.vehiclesLayer = document.createElement("div");
      this.vehiclesLayer.className = "rm-sublayer rm-vehicles-layer";

      this.pinsLayer = document.createElement("div");
      this.pinsLayer.className = "rm-sublayer rm-pins-layer";

      this.markersLayer.appendChild(this.trainsLayer);
      this.markersLayer.appendChild(this.stopsLayer);
      this.markersLayer.appendChild(this.routeStopsLayer);
      this.markersLayer.appendChild(this.centerStopsLayer);
      this.markersLayer.appendChild(this.savedStopsLayer);
      this.markersLayer.appendChild(this.vehiclesLayer);
      this.markersLayer.appendChild(this.pinsLayer);

      this.world.appendChild(this.tileLayer);
      this.world.appendChild(this.svgLayer);
      this.world.appendChild(this.markersLayer);
      this.viewport.appendChild(this.world);

      // Floating Zoom Controls (+ and −)
      this.zoomControls = document.createElement("div");
      this.zoomControls.className = "rm-zoom-controls";
      this.zoomControls.innerHTML = `
        <button class="rm-zoom-btn" id="rm-btn-zin" title="Aproximar">+</button>
        <button class="rm-zoom-btn" id="rm-btn-zout" title="Afastar">−</button>
      `;
      this.viewport.appendChild(this.zoomControls);
      this.container.appendChild(this.viewport);

      this.zoomControls.querySelector("#rm-btn-zin").onclick = (e) => {
        e.stopPropagation();
        this.setZoom(this.zoom + 1);
      };
      this.zoomControls.querySelector("#rm-btn-zout").onclick = (e) => {
        e.stopPropagation();
        this.setZoom(this.zoom - 1);
      };
    }

    project(lat, lng, zoom = this.zoom) {
      const siny = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
      const x = 256 * (0.5 + lng / 360) * Math.pow(2, zoom);
      const y = 256 * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * Math.pow(2, zoom);
      return { x, y };
    }

    unproject(x, y, zoom = this.zoom) {
      const scale = 256 * Math.pow(2, zoom);
      const lng = (x / scale - 0.5) * 360;
      const n = Math.PI - 2 * Math.PI * (y / scale);
      const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
      return { lat, lng };
    }

    latLngToScreen(lat, lng) {
      const w = this.container.clientWidth || window.innerWidth || 360;
      const h = this.container.clientHeight || (window.innerHeight / 2) || 400;
      const centerPx = this.project(this.center.lat, this.center.lng);
      const ptPx = this.project(lat, lng);
      return {
        x: ptPx.x - centerPx.x + w / 2,
        y: ptPx.y - centerPx.y + h / 2
      };
    }

    screenToLatLng(screenX, screenY) {
      const w = this.container.clientWidth || window.innerWidth || 360;
      const h = this.container.clientHeight || (window.innerHeight / 2) || 400;
      const centerPx = this.project(this.center.lat, this.center.lng);
      const worldX = centerPx.x + (screenX - w / 2);
      const worldY = centerPx.y + (screenY - h / 2);
      return this.unproject(worldX, worldY);
    }

    getTileUrl(x, y, z) {
      const maxTile = Math.pow(2, z);
      const normX = ((x % maxTile) + maxTile) % maxTile;
      if (y < 0 || y >= maxTile) return null;

      // OpenStreetMap 100% Livre e Comunitário com balanceamento entre subdomínios a, b, c
      const sub = ["a", "b", "c"][(normX + y) % 3];
      return `https://${sub}.tile.openstreetmap.org/${z}/${normX}/${y}.png`;
    }

    setTileTier() {
      this.clearTiles();
      this.render();
      logMsg("RadarMap: Servidor de Tiles fixado exclusivamente no OpenStreetMap.");
    }

    getTileTierName() {
      return "OpenStreetMap (100% Livre)";
    }

    renderTiles() {
      const w = this.container.clientWidth || window.innerWidth || 360;
      const h = this.container.clientHeight || (window.innerHeight / 2) || 400;
      const z = this.zoom;
      const centerPx = this.project(this.center.lat, this.center.lng, z);
      const topLeftX = centerPx.x - w / 2;
      const topLeftY = centerPx.y - h / 2;

      const buffer = 2; // 2 tile buffer around screen margins for smooth scrolling and caching
      const startCol = Math.floor(topLeftX / 256) - buffer;
      const endCol = Math.floor((topLeftX + w) / 256) + buffer;
      const startRow = Math.floor(topLeftY / 256) - buffer;
      const endRow = Math.floor((topLeftY + h) / 256) + buffer;

      const neededKeys = new Set();
      const maxTile = Math.pow(2, z);

      for (let c = startCol; c <= endCol; c++) {
        for (let r = startRow; r <= endRow; r++) {
          if (r < 0 || r >= maxTile) continue;
          const normC = ((c % maxTile) + maxTile) % maxTile;
          const key = `${z}_${c}_${r}`;
          neededKeys.add(key);

          let tileImg = this.tilesMap.get(key);
          const posX = Math.round(c * 256 - topLeftX);
          const posY = Math.round(r * 256 - topLeftY);

          if (!tileImg) {
            tileImg = document.createElement("img");
            tileImg.className = "rm-tile";
            tileImg.crossOrigin = "anonymous";
            tileImg.decoding = "async";
            tileImg._c = normC;
            tileImg._r = r;
            tileImg._z = z;

            tileImg.onerror = () => {
              const altSub = ["b", "c", "a"][tileImg._c % 3];
              tileImg.src = `https://${altSub}.tile.openstreetmap.org/${tileImg._z}/${tileImg._c}/${tileImg._r}.png`;
            };

            const srcUrl = this.getTileUrl(normC, r, z);
            if (srcUrl) tileImg.src = srcUrl;

            this.tileLayer.appendChild(tileImg);
            this.tilesMap.set(key, tileImg);
          }

          tileImg.style.transform = `translate3d(${posX}px, ${posY}px, 0)`;
        }
      }

      // Cleanup out of bounds tiles
      for (const [key, img] of this.tilesMap.entries()) {
        if (!neededKeys.has(key)) {
          if (img.parentNode) img.parentNode.removeChild(img);
          this.tilesMap.delete(key);
        }
      }
    }

    renderSvg() {
      const w = this.container.clientWidth || window.innerWidth || 360;
      const h = this.container.clientHeight || (window.innerHeight / 2) || 400;
      this.svgLayer.setAttribute("width", w);
      this.svgLayer.setAttribute("height", h);

      let svgContent = "";

      // 1. Walking radius circle around Home
      if (this.homePos && this.homeRadius > 0) {
        const pt = this.latLngToScreen(this.homePos.lat, this.homePos.lng);
        const metersPerPx = (156543.03392 * Math.cos((this.homePos.lat * Math.PI) / 180)) / Math.pow(2, this.zoom);
        const rPx = Math.max(10, Math.round(this.homeRadius / metersPerPx));
        svgContent += `<circle cx="${Math.round(pt.x)}" cy="${Math.round(pt.y)}" r="${rPx}" fill="rgba(16,185,129,0.15)" stroke="#10b981" stroke-width="2" stroke-dasharray="6,6" />`;
      }

      // 1.5 Linha Férrea Trensurb (Trilhos de trem em dois tons)
      if (this.trainTrack && this.trainTrack.length > 1) {
        let trainPointsStr = "";
        for (let i = 0; i < this.trainTrack.length; i++) {
          const p = this.trainTrack[i];
          const s = this.latLngToScreen(p.lat, p.lng);
          trainPointsStr += `${Math.round(s.x)},${Math.round(s.y)} `;
        }
        svgContent += `<polyline points="${trainPointsStr.trim()}" stroke="#0369a1" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.8" />`;
        svgContent += `<polyline points="${trainPointsStr.trim()}" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="5,6" fill="none" opacity="0.95" />`;
      }

      // 1.8. Corredores de Rotas em Segundo Plano (Traçados discretos dos ônibus visíveis quando zoom >= 15)
      if (this.showFleetCorridors && this.zoom >= 15 && this.ambientRoutes) {
        for (const [iti, r] of this.ambientRoutes.entries()) {
          if (this.routes.has(iti)) continue;
          if (!r.points || r.points.length === 0) continue;
          let aStr = "";
          for (let i = 0; i < r.points.length; i++) {
            const p = r.points[i];
            const s = this.latLngToScreen(p.lat, p.lng);
            aStr += `${Math.round(s.x)},${Math.round(s.y)} `;
          }
          const aColor = r.color || "#38bdf8";
          svgContent += `<polyline points="${aStr.trim()}" stroke="${aColor}" stroke-width="2.8" stroke-dasharray="6,7" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.32" />`;
        }
      }

      // 2. Multi-route Polylines com Animação Marching Dashes no Sentido da Viagem
      for (const route of this.routes.values()) {
        if (!route.points || route.points.length === 0) continue;
        let pointsStr = "";
        for (let i = 0; i < route.points.length; i++) {
          const p = route.points[i];
          const s = this.latLngToScreen(p.lat, p.lng);
          pointsStr += `${Math.round(s.x)},${Math.round(s.y)} `;
        }
        pointsStr = pointsStr.trim();
        const baseColor = route.color || "#2563eb";
        const isReverse = Boolean(route.reverseFlow);
        const flowClass = isReverse ? "route-flow-reverse" : "route-flow-forward";

        // 2.1 Linha base semi-translúcida (Trilho)
        svgContent += `<polyline points="${pointsStr}" stroke="${baseColor}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.45" />`;

        // 2.2 Linha animada pulsando no sentido do ônibus / viagem (Marching Dashes)
        svgContent += `<polyline class="route-animated-flow ${flowClass}" points="${pointsStr}" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="10, 12" fill="none" opacity="0.95" />`;

        // 2.3 Marcador de Origem (Verde) e Destino (Vermelho)
        const pStart = this.latLngToScreen(route.points[0].lat, route.points[0].lng);
        const pEnd = this.latLngToScreen(route.points[route.points.length - 1].lat, route.points[route.points.length - 1].lng);
        const origPt = isReverse ? pEnd : pStart;
        const destPt = isReverse ? pStart : pEnd;

        svgContent += `<circle cx="${Math.round(origPt.x)}" cy="${Math.round(origPt.y)}" r="6.5" fill="#10b981" stroke="#ffffff" stroke-width="2" />`;
        svgContent += `<circle cx="${Math.round(destPt.x)}" cy="${Math.round(destPt.y)}" r="7" fill="#ef4444" stroke="#ffffff" stroke-width="2" />`;
      }

      this.svgLayer.innerHTML = svgContent;
    }

    renderSavedStopsMarkers() {
      if (!this.savedStopsLayer) return;
      const w = this.container.clientWidth || window.innerWidth || 360;
      const h = this.container.clientHeight || (window.innerHeight / 2) || 400;

      const newDoms = new Map();
      // Paradas Salvas SEMPRE devem aparecer em tela (em qualquer nível de zoom)
      for (const s of (this.savedStops || [])) {
        const sLat = parseFloat(s.y !== undefined ? s.y : s.lat);
        const sLng = parseFloat(s.x !== undefined ? s.x : s.lng);
        if (isNaN(sLat) || isNaN(sLng)) continue;

        const pt = this.latLngToScreen(sLat, sLng);
        if (pt.x < -60 || pt.x > w + 60 || pt.y < -60 || pt.y > h + 60) continue;

        const key = `saved_${s.cod}`;
        let el = this.savedStopDoms.get(key);
        const shortDesc = (s.desc || s.descricao || `Parada ${s.cod}`).split("-")[0].trim().substring(0, 16);

        if (!el) {
          el = document.createElement("div");
          el.className = "rm-marker leaflet-saved-stop-icon";
          el.innerHTML = `⭐<span class="leaflet-saved-stop-tag">${shortDesc}</span>`;
          el.title = `★ Parada Salva: ${s.desc || s.cod} (Toque para ver horários)`;
          el.onclick = (e) => {
            e.stopPropagation();
            if (this.onSavedStopClick) this.onSavedStopClick(s);
            else if (this.onStopClick) this.onStopClick(s, false);
          };
          this.savedStopsLayer.appendChild(el);
        } else {
          const tag = el.querySelector(".leaflet-saved-stop-tag");
          if (tag && tag.textContent !== shortDesc) tag.textContent = shortDesc;
        }

        el.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) translate(-50%, -50%)`;
        newDoms.set(key, el);
      }

      for (const [key, el] of this.savedStopDoms.entries()) {
        if (!newDoms.has(key)) {
          if (el.parentNode) el.parentNode.removeChild(el);
        }
      }
      this.savedStopDoms = newDoms;
    }

    renderStopsMarkers() {
      if (!this.stopsLayer) return;
      const w = this.container.clientWidth || window.innerWidth || 360;
      const h = this.container.clientHeight || (window.innerHeight / 2) || 400;

      const newDoms = new Map();

      // Paradas regulares aparecem quando o usuário dá zoom de rua (zoom >= 15)
      if (this.zoom >= 15) {
        const savedCodes = new Set((this.savedStops || []).map((s) => String(s.cod)));

        // 1. Paradas de Embarque / Origem (Amarelas) - Limitado a 20 paradas
        const origList = (this.stops || []).slice(0, 20);
        for (const s of origList) {
          if (savedCodes.has(String(s.cod))) continue; // Já visível como parada salva ⭐
          const sLat = parseFloat(s.y !== undefined ? s.y : s.lat);
          const sLng = parseFloat(s.x !== undefined ? s.x : s.lng);
          if (isNaN(sLat) || isNaN(sLng)) continue;

          const pt = this.latLngToScreen(sLat, sLng);
          if (pt.x < -30 || pt.x > w + 30 || pt.y < -30 || pt.y > h + 30) continue;

          const key = `orig_${s.cod}`;
          let el = this.stopDoms.get(key);
          if (!el) {
            el = document.createElement("div");
            el.className = "rm-marker leaflet-stop-icon";
            el.title = s.desc || s.descricao || `Parada ${s.cod}`;
            el.onclick = (e) => {
              e.stopPropagation();
              if (this.onStopClick) this.onStopClick(s, false);
            };
            this.stopsLayer.appendChild(el);
          }
          el.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) translate(-50%, -50%)`;
          newDoms.set(key, el);
        }

        // 2. Paradas de Destino (Verdes) - Limitado a 20 paradas
        const destList = (this.destStops || []).slice(0, 20);
        for (const s of destList) {
          if (savedCodes.has(String(s.cod))) continue;
          const sLat = parseFloat(s.y !== undefined ? s.y : s.lat);
          const sLng = parseFloat(s.x !== undefined ? s.x : s.lng);
          if (isNaN(sLat) || isNaN(sLng)) continue;

          const pt = this.latLngToScreen(sLat, sLng);
          if (pt.x < -30 || pt.x > w + 30 || pt.y < -30 || pt.y > h + 30) continue;

          const key = `dest_${s.cod}`;
          let el = this.stopDoms.get(key);
          if (!el) {
            el = document.createElement("div");
            el.className = "rm-marker leaflet-stop-dest-icon";
            el.title = s.desc || s.descricao || `Parada de Destino ${s.cod}`;
            el.onclick = (e) => {
              e.stopPropagation();
              if (this.onStopClick) this.onStopClick(s, true);
            };
            this.stopsLayer.appendChild(el);
          }
          el.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) translate(-50%, -50%)`;
          newDoms.set(key, el);
        }
      }

      for (const [key, el] of this.stopDoms.entries()) {
        if (!newDoms.has(key)) {
          if (el.parentNode) el.parentNode.removeChild(el);
        }
      }
      this.stopDoms = newDoms;
    }

    renderRouteStopsMarkers() {
      if (!this.routeStopsLayer) return;
      const w = this.container.clientWidth || window.innerWidth || 360;
      const h = this.container.clientHeight || (window.innerHeight / 2) || 400;

      const newDoms = new Map();

      // Exibe os pontos exatos de parada da linha apenas ao dar zoom (zoom >= 15)
      if (this.zoom >= 15) {
        for (const s of (this.routeStops || [])) {
          const sLat = parseFloat(s.lat !== undefined ? s.lat : s.y);
          const sLng = parseFloat(s.lng !== undefined ? s.lng : s.x);
          if (isNaN(sLat) || isNaN(sLng)) continue;

          const pt = this.latLngToScreen(sLat, sLng);
          if (pt.x < -60 || pt.x > w + 60 || pt.y < -60 || pt.y > h + 60) continue;

          const key = `route_${s.cod || `${sLat}_${sLng}`}`;
          let el = this.routeStopDoms.get(key);
          const stopColor = s.routeColor || "#2563eb";

          if (!el) {
            el = document.createElement("div");
            el.className = "rm-marker rm-route-stop-marker";
            el.innerHTML = `<div class="rm-route-stop-dot" style="background:${stopColor};"></div>`;
            el.title = `${s.desc || `Parada ${s.cod}`} • Toque para ver detalhes`;
            el.onclick = (e) => {
              e.stopPropagation();
              if (this.onRouteStopClick) this.onRouteStopClick(s);
            };
            this.routeStopsLayer.appendChild(el);
          } else {
            const dot = el.querySelector(".rm-route-stop-dot");
            if (dot && dot.style.background !== stopColor) dot.style.background = stopColor;
          }

          el.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) translate(-50%, -50%)`;
          newDoms.set(key, el);
        }
      }

      for (const [key, el] of this.routeStopDoms.entries()) {
        if (!newDoms.has(key)) {
          if (el.parentNode) el.parentNode.removeChild(el);
          this.routeStopDoms.delete(key);
        }
      }
      this.routeStopDoms = newDoms;
    }

    renderCenterStopsMarkers() {
      if (!this.centerStopsLayer) return;
      const w = this.container.clientWidth || window.innerWidth || 360;
      const h = this.container.clientHeight || (window.innerHeight / 2) || 400;

      const newDoms = new Map();

      // Zoom mínimo de nível de rua para paradas de centro (zoom >= 16)
      if (this.zoom >= 16) {
        const centerList = (this.centerStops || []).slice(0, 10);
        for (const s of centerList) {
          const sLat = parseFloat(s.y !== undefined ? s.y : s.lat);
          const sLng = parseFloat(s.x !== undefined ? s.x : s.lng);
          if (isNaN(sLat) || isNaN(sLng)) continue;

          const isOrig = (this.stops || []).some((os) => os.cod === s.cod);
          const isDest = (this.destStops || []).some((ds) => ds.cod === s.cod);
          const isSaved = (this.savedStops || []).some((ss) => ss.cod === s.cod);
          if (isOrig || isDest || isSaved) continue;

          const pt = this.latLngToScreen(sLat, sLng);
          if (pt.x < -40 || pt.x > w + 40 || pt.y < -40 || pt.y > h + 40) continue;

          const key = `center_${s.cod}`;
          let el = this.centerStopDoms.get(key);
          const shortName = (s.descricao || s.desc || "Parada").substring(0, 16);

          if (!el) {
            el = document.createElement("div");
            el.className = "rm-marker leaflet-center-stop-icon";
            el.innerHTML = `🚏<span class="leaflet-center-stop-tag">${shortName}</span>`;
            el.title = `Parada ${s.descricao || s.cod} (Toque para ver linhas ou usar como Origem/Destino)`;
            el.onclick = (e) => {
              e.stopPropagation();
              if (this.onCenterStopClick) {
                this.onCenterStopClick(s);
              } else if (this.onStopClick) {
                this.onStopClick(s, false);
              }
            };
            this.centerStopsLayer.appendChild(el);
          }

          el.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) translate(-50%, -50%)`;
          newDoms.set(key, el);
        }
      }

      for (const [key, el] of this.centerStopDoms.entries()) {
        if (!newDoms.has(key)) {
          if (el.parentNode) el.parentNode.removeChild(el);
        }
      }
      this.centerStopDoms = newDoms;
    }

    renderTrainsMarkers() {
      if (!this.trainsLayer) return;
      const w = this.container.clientWidth || window.innerWidth || 360;
      const h = this.container.clientHeight || (window.innerHeight / 2) || 400;

      const newStationDoms = new Map();
      const newTrainDoms = new Map();

      const enabled = !(typeof window.isTrensurbEnabled === "function" && !window.isTrensurbEnabled());

      if (enabled) {
        // Estações Trensurb
        for (const st of this.trainStations) {
          const pt = this.latLngToScreen(st.lat, st.lng);
          if (pt.x < -50 || pt.x > w + 50 || pt.y < -50 || pt.y > h + 50) continue;

          const key = `station_${st.name}`;
          let el = this.trainStationDoms.get(key);
          if (!el) {
            el = document.createElement("div");
            el.className = `rm-marker leaflet-train-station-icon ${st.vip ? "vip" : ""}`;
            el.innerHTML = `🚈<span class="leaflet-station-tag">${st.name}</span>`;
            el.title = `Estação ${st.name} (Trensurb)`;
            el.onclick = (e) => {
              e.stopPropagation();
              if (this.onTrainStationClick) this.onTrainStationClick(st);
            };
            this.trainsLayer.appendChild(el);
          }
          el.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) translate(-50%, -50%)`;
          newStationDoms.set(key, el);
        }

        // Trens Trensurb
        for (const tr of this.trains) {
          if (!tr.lat || !tr.lng) continue;
          const pt = this.latLngToScreen(tr.lat, tr.lng);
          if (pt.x < -60 || pt.x > w + 60 || pt.y < -60 || pt.y > h + 60) continue;

          const key = `train_${tr.trainId || tr.shortName}`;
          let el = this.trainDoms.get(key);
          const dirClass = tr.isNorth ? "dir-north" : "dir-south";
          const modelClass = tr.isNewModel ? "train-new" : "train-classic";
          const iconEmoji = tr.isNewModel ? "🚆" : "🚈";
          const dirArrow = tr.isNorth ? "↑" : "↓";
          const glassBadge = tr.isNewModel
            ? `<span class="train-glass-tag glass-yellow" title="Série 200: Vidros Amarelos UV (Ar Condicionado)">❄️ AR</span>`
            : `<span class="train-glass-tag glass-white" title="Série 100: Vidros Brancos (Ventilação)">💨 S100</span>`;

          if (!el) {
            el = document.createElement("div");
            el.className = `rm-marker leaflet-train-icon ${dirClass} ${modelClass}`;
            el.innerHTML = `${glassBadge}${iconEmoji}<span class="leaflet-train-tag ${dirClass}">${dirArrow} ${tr.shortName || tr.trainId}</span>`;
            el.onclick = (e) => {
              e.stopPropagation();
              if (this.onTrainClick) this.onTrainClick(tr);
            };
            this.trainsLayer.appendChild(el);
          } else {
            el.className = `rm-marker leaflet-train-icon ${dirClass} ${modelClass}`;
            el.innerHTML = `${glassBadge}${iconEmoji}<span class="leaflet-train-tag ${dirClass}">${dirArrow} ${tr.shortName || tr.trainId}</span>`;
          }
          el.title = `${tr.trainId || "Trem"} • ${tr.isNewModel ? "Série 200 (Ar Condicionado)" : "Série 100 (Clássico)"} • ${tr.direction || ""}`;
          el.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) translate(-50%, -50%)`;
          newTrainDoms.set(key, el);
        }
      }

      for (const [key, el] of this.trainStationDoms.entries()) {
        if (!newStationDoms.has(key)) {
          if (el.parentNode) el.parentNode.removeChild(el);
        }
      }
      this.trainStationDoms = newStationDoms;

      for (const [key, el] of this.trainDoms.entries()) {
        if (!newTrainDoms.has(key)) {
          if (el.parentNode) el.parentNode.removeChild(el);
        }
      }
      this.trainDoms = newTrainDoms;
    }

    renderVehiclesMarkers() {
      if (!this.vehiclesLayer) return;
      const w = this.container.clientWidth || window.innerWidth || 360;
      const h = this.container.clientHeight || (window.innerHeight / 2) || 400;

      const newDoms = new Map();
      const allVeics = this.vehicles || [];

      // 1. Separa ônibus salvos/rastreados (sempre exibidos em tela) de ônibus genéricos
      const savedOrTracked = [];
      const generic = [];

      for (const v of allVeics) {
        const vLat = parseFloat(v.lat);
        const vLng = parseFloat(v.long !== undefined ? v.long : v.lng);
        if (isNaN(vLat) || isNaN(vLng)) continue;

        const isSavedOrTracked = Boolean(
          v.isSaved ||
          v._isTracked ||
          this.routes.has(parseInt(v.codIti, 10)) ||
          this.routes.has(v.codIti)
        );

        if (isSavedOrTracked) {
          savedOrTracked.push(v);
        } else {
          const dCenter = Math.hypot(vLat - this.center.lat, vLng - this.center.lng);
          generic.push({ v, dCenter });
        }
      }

      // 2. Escala a densidade de ônibus genéricos conforme o nível de zoom
      // Quanto mais aberto o zoom, menos ônibus; conforme aproxima, vai aumentando
      let maxGenericAllowed = 0;
      if (this.zoom >= 17) maxGenericAllowed = 35;
      else if (this.zoom === 16) maxGenericAllowed = 20;
      else if (this.zoom === 15) maxGenericAllowed = 10;
      else if (this.zoom === 14) maxGenericAllowed = 4;
      else maxGenericAllowed = 0; // zoom < 14: foco absoluto em ônibus salvos/traçados

      generic.sort((a, b) => a.dCenter - b.dCenter);
      const chosenGeneric = generic.slice(0, maxGenericAllowed).map((item) => item.v);
      const veicsToRender = [...savedOrTracked, ...chosenGeneric];

      for (const v of veicsToRender) {
        const vLat = parseFloat(v.lat);
        const vLng = parseFloat(v.long !== undefined ? v.long : v.lng);
        const pt = this.latLngToScreen(vLat, vLng);
        if (pt.x < -60 || pt.x > w + 60 || pt.y < -60 || pt.y > h + 60) continue;

        const id = v.numVeicGestor || v.veiculo || v.prefixo || `${vLat}_${vLng}`;
        const lineCode = (v.descricao || v.sgLin || v.lineCode || "").substring(0, 5);
        const heading = (v.heading !== undefined && v.heading !== null) ? v.heading : null;
        const arrowSvg = heading !== null 
          ? `<svg class="leaflet-bus-arrow" viewBox="0 0 24 24" width="13" height="13" style="transform: rotate(${heading}deg);"><path fill="#38bdf8" d="M12 2L4 20l8-4 8 4z"/></svg>`
          : "";

        // Destaque do Ônibus/Linha Selecionado e Discrição dos Demais Ônibus
        const hasFocus = Boolean(this.selectedBusId) || this.routes.size > 0;
        const isSelectedBus = Boolean(this.selectedBusId && (id === this.selectedBusId || v.numVeicGestor === this.selectedBusId));
        const isTrackedLine = this.routes.has(parseInt(v.codIti, 10)) || this.routes.has(v.codIti) || (this.selectedLineCode && String(v.descricao || v.sgLin || '').toUpperCase().includes(String(this.selectedLineCode).toUpperCase()));

        let stateClass = "";
        let scaleTransform = "";
        if (hasFocus) {
          if (isSelectedBus) {
            stateClass = " leaflet-bus-selected";
            scaleTransform = " scale(1.24)";
          } else if (isTrackedLine) {
            stateClass = " leaflet-bus-focused";
            scaleTransform = " scale(1.06)";
          } else {
            stateClass = " leaflet-bus-dimmed";
            scaleTransform = " scale(0.82)";
          }
        }

        let el = this.vehicleDoms.get(id);
        if (!el) {
          el = document.createElement("div");
          el.className = "rm-marker leaflet-bus-icon" + stateClass;
          el.innerHTML = `${arrowSvg}🚌${lineCode ? `<span class="leaflet-bus-tag">${lineCode}</span>` : ""}`;
          el._vehicle = v;
          el.onclick = (e) => {
            e.stopPropagation();
            const target = el._vehicle;
            if (this.onBusClick && target) this.onBusClick(target, target.codIti);
          };
          this.vehiclesLayer.appendChild(el);
        } else {
          el._vehicle = v;
          el.className = "rm-marker leaflet-bus-icon" + stateClass;
          const tag = el.querySelector(".leaflet-bus-tag");
          if (tag && lineCode && tag.textContent !== lineCode) {
            tag.textContent = lineCode;
          }
          const arrow = el.querySelector(".leaflet-bus-arrow");
          if (heading !== null) {
            if (arrow) {
              arrow.style.transform = `rotate(${heading}deg)`;
            } else {
              el.insertAdjacentHTML("afterbegin", arrowSvg);
            }
          } else if (arrow) {
            arrow.remove();
          }
        }

        // Suave reposicionamento sem destruir o nó (Zero piscada, sempre em tela)
        el.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) translate(-50%, -50%)${scaleTransform}`;
        el.title = `Ônibus ${v.numVeicGestor || v.veiculo || ""} • Linha ${v.sgLin || v.descricao || ""}${heading !== null ? ` • Sentido: ${heading}°` : ""}`;
        newDoms.set(id, el);
      }

      // Remove apenas nós que saíram da lista ativa
      for (const [id, el] of this.vehicleDoms.entries()) {
        if (!newDoms.has(id)) {
          if (el.parentNode) el.parentNode.removeChild(el);
        }
      }
      this.vehicleDoms = newDoms;
    }

    renderPinsMarkers() {
      if (!this.pinsLayer) return;
      const w = this.container.clientWidth || window.innerWidth || 360;
      const h = this.container.clientHeight || (window.innerHeight / 2) || 400;

      const newPinDoms = new Map();

      // Marcador do Usuário (GPS 📍)
      if (this.userPos) {
        const pt = this.latLngToScreen(this.userPos.lat, this.userPos.lng);
        const key = "pin_user";
        let el = this.pinDoms.get(key);
        if (!el) {
          el = document.createElement("div");
          el.className = "rm-marker leaflet-user-icon";
          el.innerHTML = "📍";
          el.title = "Minha Localização (Toque para centralizar)";
          el.onclick = (e) => {
            e.stopPropagation();
            this.setView(this.userPos.lat, this.userPos.lng, 16);
            if (this.onUserLocClick) this.onUserLocClick();
          };
          this.pinsLayer.appendChild(el);
        }
        el.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) translate(-50%, -50%)`;
        newPinDoms.set(key, el);
      }

      // Marcador de Casa (Destino 🏠)
      if (this.homePos) {
        const pt = this.latLngToScreen(this.homePos.lat, this.homePos.lng);
        const key = "pin_home";
        let el = this.pinDoms.get(key);
        if (!el) {
          el = document.createElement("div");
          el.className = "rm-marker leaflet-home-icon";
          el.innerHTML = "🏠";
          el.title = "Minha Casa (Toque para centralizar)";
          el.onclick = (e) => {
            e.stopPropagation();
            this.setView(this.homePos.lat, this.homePos.lng, 16);
          };
          this.pinsLayer.appendChild(el);
        }
        el.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) translate(-50%, -50%)`;
        newPinDoms.set(key, el);
      }

      // Marcador do Picker
      if (this.pickerPos) {
        const pt = this.latLngToScreen(this.pickerPos.lat, this.pickerPos.lng);
        const isHome = this.pickerTarget === "dest";
        const key = "pin_picker";
        let el = this.pinDoms.get(key);
        if (!el) {
          el = document.createElement("div");
          el.className = `rm-marker leaflet-picker-drag ${isHome ? "leaflet-home-icon" : "leaflet-user-icon"}`;
          el.innerHTML = isHome ? "🏠" : "📍";
          this.pinsLayer.appendChild(el);
        } else {
          el.className = `rm-marker leaflet-picker-drag ${isHome ? "leaflet-home-icon" : "leaflet-user-icon"}`;
          el.innerHTML = isHome ? "🏠" : "📍";
        }
        el.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0) translate(-50%, -50%)`;
        newPinDoms.set(key, el);
      }

      for (const [key, el] of this.pinDoms.entries()) {
        if (!newPinDoms.has(key)) {
          if (el.parentNode) el.parentNode.removeChild(el);
        }
      }
      this.pinDoms = newPinDoms;
    }

    renderMarkers() {
      this.renderSavedStopsMarkers();
      this.renderRouteStopsMarkers();
      this.renderStopsMarkers();
      this.renderCenterStopsMarkers();
      this.renderTrainsMarkers();
      this.renderVehiclesMarkers();
      this.renderPinsMarkers();
    }

    setTrainStations(stations, onClick) {
      this.trainStations = stations || [];
      if (onClick) this.onTrainStationClick = onClick;
      this.renderTrainsMarkers();
    }

    setTrains(trains, onClick) {
      this.trains = trains || [];
      if (onClick) this.onTrainClick = onClick;
      this.renderTrainsMarkers();
    }

    setTrainTrack(points) {
      this.trainTrack = points || [];
      this.renderSvg();
    }

    setCenterStops(stops, onClick) {
      this.centerStops = stops || [];
      if (onClick) this.onCenterStopClick = onClick;
      this.renderCenterStopsMarkers();
    }

    render() {
      this.renderTiles();
      this.renderSvg();
      this.renderMarkers();
    }

    bindEvents() {
      let isDown = false;
      let startX = 0;
      let startY = 0;
      let diffX = 0;
      let diffY = 0;
      let hasDragged = false;
      let initialPinchDist = null;
      let lastPinchStepTime = 0;
      let rafPending = false;

      const onStart = (clientX, clientY) => {
        isDown = true;
        hasDragged = false;
        startX = clientX;
        startY = clientY;
        diffX = 0;
        diffY = 0;
      };

      const onMove = (clientX, clientY) => {
        if (!isDown) return;
        diffX = clientX - startX;
        diffY = clientY - startY;

        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(() => {
            rafPending = false;
            if (isDown && (Math.abs(diffX) > 8 || Math.abs(diffY) > 8)) {
              hasDragged = true;
              this.world.style.transform = `translate3d(${diffX}px, ${diffY}px, 0)`;
            }
          });
        }
      };

      const onEnd = () => {
        if (!isDown) return;
        isDown = false;

        if (hasDragged) {
          this.world.style.transform = "translate3d(0, 0, 0)";
          const w = this.container.clientWidth || 360;
          const h = this.container.clientHeight || 400;
          this.center = this.screenToLatLng(w / 2 - diffX, h / 2 - diffY);
          // Preserve existing tile DOM nodes across pans for zero stutter
          this.render();
          this.trigger("moveend", this.center);
        }
      };

      // Mouse events
      this.viewport.addEventListener("mousedown", (e) => {
        onStart(e.clientX, e.clientY);
      });
      window.addEventListener("mousemove", (e) => {
        onMove(e.clientX, e.clientY);
      });
      window.addEventListener("mouseup", () => {
        onEnd();
      });

      // Touch events (Single finger pan & Smooth Pinch zoom)
      this.viewport.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches.length === 1) {
            onStart(e.touches[0].clientX, e.touches[0].clientY);
          } else if (e.touches.length === 2) {
            isDown = false;
            initialPinchDist = Math.hypot(
              e.touches[0].clientX - e.touches[1].clientX,
              e.touches[0].clientY - e.touches[1].clientY
            );
            lastPinchStepTime = Date.now();
          }
        },
        { passive: true }
      );

      this.viewport.addEventListener(
        "touchmove",
        (e) => {
          if (e.touches.length === 1) {
            onMove(e.touches[0].clientX, e.touches[0].clientY);
          } else if (e.touches.length === 2 && initialPinchDist) {
            const currentDist = Math.hypot(
              e.touches[0].clientX - e.touches[1].clientX,
              e.touches[0].clientY - e.touches[1].clientY
            );
            const now = Date.now();
            if (now - lastPinchStepTime >= 280) {
              const ratio = currentDist / initialPinchDist;
              if (ratio >= 1.35) {
                this.setZoom(this.zoom + 1);
                initialPinchDist = currentDist;
                lastPinchStepTime = now;
              } else if (ratio <= 0.74) {
                this.setZoom(this.zoom - 1);
                initialPinchDist = currentDist;
                lastPinchStepTime = now;
              }
            }
          }
        },
        { passive: true }
      );

      this.viewport.addEventListener("touchend", () => {
        initialPinchDist = null;
        onEnd();
      });

      // Map Click (for location picker)
      this.viewport.addEventListener("click", (e) => {
        if (!hasDragged) {
          const rect = this.viewport.getBoundingClientRect();
          const clickX = e.clientX - rect.left;
          const clickY = e.clientY - rect.top;
          const latLng = this.screenToLatLng(clickX, clickY);
          this.trigger("click", latLng);
        }
      });

      // Mouse Wheel Zoom (Scroll do mouse no PC)
      let wheelDebounceTimer = null;
      this.viewport.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          if (wheelDebounceTimer) return;
          wheelDebounceTimer = setTimeout(() => {
            wheelDebounceTimer = null;
          }, 120);

          if (e.deltaY < 0) {
            this.setZoom(this.zoom + 1);
          } else if (e.deltaY > 0) {
            this.setZoom(this.zoom - 1);
          }
        },
        { passive: false }
      );
    }

    clearTiles() {
      this.tileLayer.innerHTML = "";
      this.tilesMap.clear();
    }

    setView(lat, lng, zoom = this.zoom) {
      this.center = { lat, lng };
      if (zoom !== this.zoom) {
        this.zoom = Math.min(Math.max(zoom, this.minZoom), this.maxZoom);
      }
      this.render();
      this.trigger("moveend", this.center);
    }

    setZoom(newZoom) {
      const targetZoom = Math.min(Math.max(newZoom, this.minZoom), this.maxZoom);
      if (targetZoom !== this.zoom) {
        this.zoom = targetZoom;
        this.render();
        this.trigger("moveend", this.center);
      }
    }

    getZoom() {
      return this.zoom;
    }

    getCenter() {
      return { ...this.center };
    }

    fitBounds(points, padding = 40) {
      if (!points || points.length === 0) return;
      let minLat = 90,
        maxLat = -90,
        minLng = 180,
        maxLng = -180;
      for (const p of points) {
        const lat = p.lat !== undefined ? p.lat : p[0];
        const lng = p.lng !== undefined ? p.lng : p[1];
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }

      this.center = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
      const w = (this.container.clientWidth || 360) - padding * 2;
      const h = (this.container.clientHeight || 400) - padding * 2;

      for (let z = this.maxZoom; z >= this.minZoom; z--) {
        const p1 = this.project(minLat, minLng, z);
        const p2 = this.project(maxLat, maxLng, z);
        if (Math.abs(p2.x - p1.x) <= w && Math.abs(p2.y - p1.y) <= h) {
          this.zoom = z;
          break;
        }
      }
      this.render();
      this.trigger("moveend", this.center);
    }

    setUserLocation(lat, lng) {
      this.userPos = { lat, lng };
      this.renderMarkers();
    }

    setHomeLocation(lat, lng, radiusMeters) {
      this.homePos = lat && lng ? { lat, lng } : null;
      this.homeRadius = radiusMeters || 0;
      this.render();
    }

    setHomeRadius(radiusMeters) {
      this.homeRadius = radiusMeters || 0;
      this.renderSvg();
    }

    setSavedStops(stopsList = [], onClick) {
      this.savedStops = stopsList || [];
      if (onClick) this.onSavedStopClick = onClick;
      this.renderSavedStopsMarkers();
    }

    setStops(origStops = [], destStops = [], onStopClick) {
      this.stops = origStops || [];
      this.destStops = destStops || [];
      if (onStopClick) this.onStopClick = onStopClick;
      this.renderStopsMarkers();
    }

    setRouteStops(stopsList = [], onStopClick) {
      this.routeStops = stopsList || [];
      if (onStopClick) this.onRouteStopClick = onStopClick;
      this.renderRouteStopsMarkers();
    }

    setVehicles(veicsList = [], onBusClick) {
      this.vehicles = veicsList || [];
      if (onBusClick) this.onBusClick = onBusClick;
      this.renderVehiclesMarkers();
    }

    setSelection(busId = null, lineCode = null) {
      this.selectedBusId = busId || null;
      this.selectedLineCode = lineCode || null;
      this.renderVehiclesMarkers();
    }

    setShowFleetCorridors(show) {
      this.showFleetCorridors = Boolean(show);
      this.renderSvg();
    }

    setRoutes(routesMap) {
      this.routes = routesMap;
      this.renderSvg();
      this.renderVehiclesMarkers();
    }

    setPicker(lat, lng, isHome) {
      this.pickerPos = { lat, lng };
      this.pickerTarget = isHome ? "dest" : "origin";
      this.renderMarkers();
    }

    clearPicker() {
      this.pickerPos = null;
      this.pickerTarget = null;
      this.renderMarkers();
    }

    resize() {
      this.clearTiles();
      this.render();
    }

    on(event, callback) {
      if (this.callbacks[event]) {
        this.callbacks[event].push(callback);
      }
    }

    trigger(event, data) {
      if (this.callbacks[event]) {
        this.callbacks[event].forEach((cb) => cb(data));
      }
    }
  }

  // --- STATE VARIABLES ---
  let map = null;
  let userCoords = { ...CANOAS_CENTRO };
  let homeCoords = null;
  let hasCenteredOnInitialGps = false;
  let walkingRadius = 1200; // padrão 1.2km

  // Origem e Destino do Trajeto Dinâmico
  let originMode = "gps"; // "gps", "home", "stop", "custom"
  let originCoords = { ...CANOAS_CENTRO };
  let originLabel = "Meu GPS (Posição Atual)";
  let originStop = null;

  let destMode = "home"; // "home", "gps", "stop", "custom"
  let destCoords = null;
  let destLabel = "Minha Casa";
  let destStop = null;

  const ROUTE_STYLES = [
    { id: 0, color: "#2563eb", name: "Azul", dash: null, label: "Sólido" },
    { id: 1, color: "#ef4444", name: "Vermelho", dash: "10, 8", label: "Tracejado" },
    { id: 2, color: "#10b981", name: "Verde", dash: null, label: "Sólido" },
    { id: 3, color: "#f59e0b", name: "Laranja", dash: "8, 6", label: "Tracejado" },
    { id: 4, color: "#8b5cf6", name: "Roxo", dash: null, label: "Sólido" }
  ];

  let activeRoutes = new Map(); // codIti -> { codIti, lineCode, lineName, color, dash, points }
  let currentMatches = [];
  let isFetching = false;
  let moveDebounceTimer = null;
  let searchDebounceTimer = null;
  let pickingTarget = null;
  let currentSelectedStop = null;
  let currentSelectedBus = null;
  const itiStopsCache = new Map();

  // Pending native asynchronous HTTP requests
  window.pendingNativeRequests = new Map();
  window.onNativeHttpResponse = function (reqId, status, b64Data) {
    const handler = window.pendingNativeRequests.get(reqId);
    if (handler) {
      window.pendingNativeRequests.delete(reqId);
      try {
        const decoded = new TextDecoder("utf-8").decode(
          Uint8Array.from(atob(b64Data), (c) => c.charCodeAt(0))
        );
        handler(status, decoded);
      } catch (err) {
        handler(-1, null);
      }
    }
  };

  // --- 5 NETWORK FALLBACKS ENGINE ---
  function callSiuJsonp(url) {
    return new Promise((resolve) => {
      const parts = url.split("/");
      const cbName = parts[parts.length - 1];
      const script = document.createElement("script");
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({ sucesso: false, erro: "timeout" });
        }
      }, 7000);

      function cleanup() {
        clearTimeout(timer);
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[cbName] = function (data) {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(data);
        }
      };

      script.onerror = function () {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({ sucesso: false, erro: "network_error" });
        }
      };

      script.src = url;
      document.body.appendChild(script);
    });
  }

  function getOfflineFallbackData(url) {
    if (url.includes("buscarParadasProximas")) {
      return {
        sucesso: true,
        paradas: [
          { cod: 1001, desc: "Estação Canoas / Centro - Av. Victor Barreto", x: -51.1804, y: -29.9189 },
          { cod: 1002, desc: "Praça do Avião - Av. Getúlio Vargas", x: -51.1785, y: -29.9165 },
          { cod: 1003, desc: "Canoas Shopping - Av. Guilherme Schell", x: -51.1865, y: -29.9142 },
          { cod: 1004, desc: "Estação Mathias Velho - Av. Guilherme Schell", x: -51.1872, y: -29.9048 },
          { cod: 1005, desc: "Hospital Universitário / ULBRA - Bairro São José", x: -51.1645, y: -29.8972 }
        ]
      };
    }
    if (url.includes("buscarPrevisoes") || url.includes("retornaLinhasQueAtendemParada")) {
      return {
        sucesso: true,
        previsoes: [],
        linhas: []
      };
    }
    return { sucesso: false };
  }

  async function smartFetch(url, isDirectSiu) {
    const epName = url.split("/").pop() || "req";

    // FALLBACK 1: Native Android Bridge Worker (Background Java HTTP, bypasses CORS, works on 4G)
    if (window.AndroidBridge && typeof window.AndroidBridge.httpGetAsync === "function") {
      try {
        const reqId = "req_" + Math.random().toString(36).substring(2, 9);
        const res = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            window.pendingNativeRequests.delete(reqId);
            resolve(null);
          }, 8000);

          window.pendingNativeRequests.set(reqId, (status, rawText) => {
            clearTimeout(timeout);
            if (status >= 200 && status < 400 && rawText) {
              try {
                let clean = rawText.trim();
                if (clean.includes("(") && clean.endsWith(")")) {
                  clean = clean.substring(clean.indexOf("(") + 1, clean.lastIndexOf(")"));
                }
                resolve(JSON.parse(clean));
              } catch (e) {
                resolve(null);
              }
            } else {
              resolve(null);
            }
          });

          window.AndroidBridge.httpGetAsync(reqId, url);
        });

        if (res && res.sucesso !== false && !res.erro) {
          logMsg(`Net [F1-Nativo OK] ${epName}`);
          return res;
        }
      } catch (e) {
        logMsg(`Net [F1-Nativo Falha] ${e.message}`);
      }
    }

    // FALLBACK 2: Servidor Proxy Local (PC e Navegador Mobile) - Rápido, sem CORS
    if (window.location.protocol.startsWith("http")) {
      try {
        const lanUrl = url.startsWith("/") ? url : `/proxy?url=${encodeURIComponent(url)}`;
        const res = await fetch(lanUrl, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
          const json = await res.json();
          if (json && json.sucesso !== false && !json.erro) {
            logMsg(`Net [F2-Proxy OK] ${epName}`);
            return json;
          }
        }
      } catch (e) {}
    }

    // FALLBACK 3: Dynamic JSONP Script Injection (Bypasses CORS for transit API on web and 4G)
    if (isDirectSiu || url.includes("siumobile")) {
      try {
        const res = await callSiuJsonp(url);
        if (res && res.sucesso !== false && !res.erro) {
          logMsg(`Net [F3-JSONP OK] ${epName}`);
          return res;
        }
      } catch (e) {
        logMsg(`Net [F3-JSONP Falha] ${e.message}`);
      }
    }

    // FALLBACK 4: Standard Browser Fetch
    try {
      const res = await fetch(url, { mode: "cors" });
      if (res.ok) {
        const json = await res.json();
        if (json && !json.erro) {
          logMsg(`Net [F4-Fetch OK] ${epName}`);
          return json;
        }
      }
    } catch (e) {}

    // FALLBACK 5: Canonical Offline Data
    logMsg(`Net [F5-Offline] ${epName}`);
    return getOfflineFallbackData(url);
  }

  // --- DOM Elements ---
  const statusText = document.getElementById("status-text");
  const activeBusesCount = document.getElementById("active-buses-count");
  const labelOrigin = document.getElementById("label-origin");
  const labelDest = document.getElementById("label-dest");
  const iconOrigin = document.getElementById("icon-origin");
  const iconDest = document.getElementById("icon-dest");
  const btnOrigGps = document.getElementById("btn-orig-gps");
  const btnOrigHome = document.getElementById("btn-orig-home");
  const btnOrigMap = document.getElementById("btn-orig-map");
  const btnDestHome = document.getElementById("btn-dest-home");
  const btnDestGps = document.getElementById("btn-dest-gps");
  const btnDestMap = document.getElementById("btn-dest-map");
  const btnSwapRoute = document.getElementById("btn-swap-route");
  const radiusButtons = document.querySelectorAll(".btn-radius");
  const homeBusList = document.getElementById("home-bus-list");

  const btnSetStopOrig = document.getElementById("btn-set-stop-orig");
  const btnSetStopDest = document.getElementById("btn-set-stop-dest");

  const homeSavedAddress = document.getElementById("home-saved-address");
  const homeSavedCoords = document.getElementById("home-saved-coords");
  const btnConfigHomeFav = document.getElementById("btn-config-home-fav");
  const btnUseHomeAsDest = document.getElementById("btn-use-home-as-dest");
  const btnUseHomeAsOrig = document.getElementById("btn-use-home-as-orig");

  const aboutBtnOpenTileCfg = document.getElementById("about-btn-open-tile-cfg");
  const aboutBtnOpenLog = document.getElementById("about-btn-open-log");
  const aboutBtnSetHome = document.getElementById("about-btn-set-home");
  const aboutBtnOpenDev = document.getElementById("about-btn-open-dev");

  function markTripNeedsCalculation() {
    tripMatchesCalculated = false;
    const btn = document.getElementById("btn-calc-trip");
    if (btn) btn.classList.add("needs-calc");
    const list = document.getElementById("home-bus-list");
    if (list && originCoords && destCoords) {
      list.innerHTML = `
        <div class="empty-state" style="padding:16px 12px;text-align:center;">
          <div style="font-size:1.6rem;margin-bottom:6px;">🚀</div>
          <div style="font-weight:800;font-size:0.9rem;color:#fff;">Origem e Destino definidos!</div>
          <p style="font-size:0.75rem;color:var(--text-muted);margin:4px 0 10px 0;">
            Toque no botão <b>🚀 IR • Traçar Melhores Rotas</b> para calcular as opções disponíveis.
          </p>
        </div>
      `;
    }
  }

  function updateRouteUI() {
    if (labelOrigin) labelOrigin.textContent = originLabel;
    if (labelDest) labelDest.textContent = destLabel;

    if (iconOrigin) {
      iconOrigin.textContent = originMode === "home" ? "🏠" : (originMode === "stop" ? "🚏" : "📍");
    }
    if (iconDest) {
      iconDest.textContent = destMode === "home" ? "🏠" : (destMode === "stop" ? "🚏" : "🎯");
    }

    if (btnOrigGps) btnOrigGps.classList.toggle("active", originMode === "gps");
    if (btnOrigHome) btnOrigHome.classList.toggle("active", originMode === "home");
    if (btnOrigMap) btnOrigMap.classList.toggle("active", originMode === "custom" || originMode === "stop");

    if (btnDestHome) btnDestHome.classList.toggle("active", destMode === "home");
    if (btnDestGps) btnDestGps.classList.toggle("active", destMode === "gps");
    if (btnDestMap) btnDestMap.classList.toggle("active", destMode === "custom" || destMode === "stop");

    if (homeSavedAddress) {
      homeSavedAddress.textContent = homeCoords ? `Casa (${homeCoords.lat.toFixed(4)}, ${homeCoords.lng.toFixed(4)})` : "Casa não configurada";
    }
    if (homeSavedCoords) {
      homeSavedCoords.textContent = homeCoords ? "Local permanente salvo no dispositivo" : "Defina no mapa ou via GPS";
    }

    if (map) {
      if (originCoords) map.setUserLocation(originCoords.lat, originCoords.lng);
      if (destCoords) map.setHomeLocation(destCoords.lat, destCoords.lng, walkingRadius);
    }
  }

  const stopDetailsEmpty = document.getElementById("stop-details-empty");
  const stopDetailsContent = document.getElementById("stop-details-content");
  const stopTitle = document.getElementById("stop-title");
  const stopCode = document.getElementById("stop-code");
  const btnFavStop = document.getElementById("btn-fav-stop");
  const stopForecastsList = document.getElementById("stop-forecasts-list");
  const stopLinesWrap = document.getElementById("stop-lines-wrap");

  const busDetailsEmpty = document.getElementById("bus-details-empty");
  const busDetailsContent = document.getElementById("bus-details-content");
  const busCardTitle = document.getElementById("bus-card-title");
  const busCardDesc = document.getElementById("bus-card-desc");
  const btnFavLine = document.getElementById("btn-fav-line");
  const busTraceBtnSlot = document.getElementById("bus-trace-btn-slot");
  const busStopsTimeline = document.getElementById("bus-stops-timeline");

  const favStopsList = document.getElementById("fav-stops-list");
  const favLinesList = document.getElementById("fav-lines-list");

  const btnRefresh = document.getElementById("btn-refresh");
  const btnMyLoc = document.getElementById("btn-my-loc");
  const btnHomeLoc = document.getElementById("btn-home-loc");

  const activeRoutesTray = document.getElementById("active-routes-tray");
  const activeRoutesChips = document.getElementById("active-routes-chips");
  const btnClearAllRoutes = document.getElementById("btn-clear-all-routes");

  const pickerBanner = document.getElementById("picker-banner");
  const pickerTitle = document.getElementById("picker-title");
  const pickerSearchInput = document.getElementById("picker-search-input");
  const pickerSearchResults = document.getElementById("picker-search-results");
  const pickerBtnGps = document.getElementById("picker-btn-gps");
  const pickerBtnCancel = document.getElementById("picker-btn-cancel");
  const pickerBtnSave = document.getElementById("picker-btn-save");

  const toastNotice = document.getElementById("toast-notice");
  const mainPanel = document.getElementById("main-panel");
  const panelDragHandle = document.getElementById("panel-drag-handle");

  // Debug drawer elements
  const btnToggleLog = document.getElementById("btn-toggle-log");
  const btnCloseLog = document.getElementById("btn-close-log");
  const btnClearLog = document.getElementById("btn-clear-log");
  const debugLogDrawer = document.getElementById("debug-log-drawer");

  function showToast(msg) {
    if (!toastNotice) return;
    toastNotice.textContent = msg;
    toastNotice.style.display = "block";
    clearTimeout(toastNotice._timer);
    toastNotice._timer = setTimeout(() => {
      toastNotice.style.display = "none";
    }, 3200);
  }

  function calcDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // --- Saved Preferences (LocalStorage) ---
  try {
    const savedHome = localStorage.getItem("busradar_home_coords");
    if (savedHome) {
      homeCoords = JSON.parse(savedHome);
      destCoords = { ...homeCoords };
      destLabel = "Minha Casa";
      destMode = "home";
    }
  } catch (e) {}

  try {
    const savedRadius = localStorage.getItem("busradar_walk_radius");
    if (savedRadius) {
      walkingRadius = parseInt(savedRadius, 10);
      radiusButtons.forEach((b) => {
        b.classList.toggle("active", parseInt(b.dataset.radius, 10) === walkingRadius);
      });
    }
  } catch (e) {}

  // --- Favorites Management ---
  function getFavorites() {
    try {
      const f = localStorage.getItem("busradar_favs");
      return f ? JSON.parse(f) : { stops: [], lines: [] };
    } catch (e) {
      return { stops: [], lines: [] };
    }
  }

  function saveFavorites(data) {
    try {
      localStorage.setItem("busradar_favs", JSON.stringify(data));
      if (map && data.stops) {
        map.setSavedStops(data.stops, (s) => selectStop(s, false));
      }
      renderFavoritesTab();
    } catch (e) {}
  }

  function isStopFavorite(cod) {
    const f = getFavorites();
    return f.stops.some((s) => s.cod == cod);
  }

  function toggleFavoriteStop(stop) {
    if (!stop) return;
    const f = getFavorites();
    const idx = f.stops.findIndex((s) => s.cod == stop.cod);
    if (idx >= 0) {
      f.stops.splice(idx, 1);
      showToast(`Parada ${stop.cod} removida dos favoritos.`);
    } else {
      const sLat = parseFloat(stop.y !== undefined ? stop.y : stop.lat);
      const sLng = parseFloat(stop.x !== undefined ? stop.x : stop.lng);
      f.stops.push({
        cod: stop.cod,
        desc: stop.desc || stop.descricao || `Parada ${stop.cod}`,
        x: sLng,
        y: sLat,
        lat: sLat,
        lng: sLng
      });
      showToast(`★ Parada ${stop.cod} salva nos favoritos!`);
    }
    saveFavorites(f);
    updateFavStopButton();
  }

  function isLineFavorite(lineCode) {
    if (!lineCode) return false;
    const f = getFavorites();
    return f.lines.some((l) => l.code === lineCode);
  }

  function toggleFavoriteLine(lineCode, lineName, codIti) {
    if (!lineCode) return;
    const f = getFavorites();
    const idx = f.lines.findIndex((l) => l.code === lineCode);
    if (idx >= 0) {
      f.lines.splice(idx, 1);
      showToast(`Linha ${lineCode} removida dos favoritos.`);
    } else {
      f.lines.push({
        code: lineCode,
        name: lineName || lineCode,
        codIti: codIti || null
      });
      showToast(`★ Linha ${lineCode} salva nos favoritos!`);
    }
    saveFavorites(f);
    updateFavLineButton();
  }

  function updateFavStopButton() {
    if (!currentSelectedStop || !btnFavStop) return;
    const saved = isStopFavorite(currentSelectedStop.cod);
    btnFavStop.textContent = saved ? "★ Salva" : "⭐ Salvar";
    btnFavStop.classList.toggle("active", saved);
  }

  function updateFavLineButton() {
    if (!currentSelectedBus || !btnFavLine) return;
    const code = currentSelectedBus.lineCode;
    const saved = isLineFavorite(code);
    btnFavLine.textContent = saved ? "★ Linha Salva" : "⭐ Salvar Linha";
    btnFavLine.classList.toggle("active", saved);
  }

  async function loadSavedStopETA(cod) {
    const el = document.getElementById(`fav-stop-eta-${cod}`);
    if (!el) return;
    try {
      const fcUrl = `${SIU_BASE}/V3/buscarPrevisoes/${cod}/false/0/POA/retornoJSON`;
      const data = await smartFetch(fcUrl, true);
      const prevs = (data.previsoes || []).slice(0, 4);
      const currentEl = document.getElementById(`fav-stop-eta-${cod}`);
      if (!currentEl) return;

      if (prevs.length === 0) {
        currentEl.innerHTML = `<span style="font-size:0.68rem;color:var(--text-muted);">🌙 Nenhum ônibus com GPS ativo detectado agora</span>`;
        return;
      }

      currentEl.innerHTML = prevs.map((p) => {
        const line = (p.sgLin || "Linha").replace(/^0+/, "");
        const time = p.prev || "Em trânsito";
        const isNear = time.includes("1 ") || time.includes("2 ") || time.includes("3 ") || time.includes("4 ");
        return `<span class="fav-stop-eta-pill ${isNear ? "near" : ""}">⏱️ <b>${line}</b>: ${time}</span>`;
      }).join("");
    } catch (e) {
      const currentEl = document.getElementById(`fav-stop-eta-${cod}`);
      if (currentEl) currentEl.innerHTML = `<span style="font-size:0.68rem;color:var(--text-muted);">Toque para consultar chegadas</span>`;
    }
  }

  function renderFavoritesTab() {
    updateRouteUI();
    const favs = getFavorites();
    if (map) {
      map.setSavedStops(favs.stops || [], (s) => selectStop(s, false));
    }
    if (!favStopsList || !favLinesList) return;

    // 1. Saved Stops
    if (!favs.stops || favs.stops.length === 0) {
      favStopsList.innerHTML = `<div class="empty-state"><p>Nenhuma parada salva ainda. Toque em qualquer parada no mapa e clique em ⭐ Salvar!</p></div>`;
    } else {
      favStopsList.innerHTML = "";
      favs.stops.forEach((s) => {
        const item = document.createElement("div");
        item.className = "fav-card";
        item.innerHTML = `
          <div class="fav-card-left">
            <span class="fav-card-icon">⭐</span>
            <div style="min-width:0;flex:1;">
              <div class="fav-card-name">${(s.desc || `Parada ${s.cod}`).split("-")[0].trim()}</div>
              <div class="fav-card-sub">Código: ${s.cod} • Toque para ver itinerário</div>
              <div class="fav-stop-eta-row" id="fav-stop-eta-${s.cod}">
                <span style="font-size:0.68rem;color:var(--accent-light);">🔄 Consultando previsões ao vivo...</span>
              </div>
            </div>
          </div>
          <div class="fav-card-actions">
            <button class="btn-fav-delete" title="Excluir dos favoritos">✕</button>
          </div>
        `;
        item.querySelector(".fav-card-left").onclick = () => {
          if (s.y && s.x && map) {
            map.setView(s.y, s.x, 16);
          }
          selectStop(s, false);
        };
        item.querySelector(".btn-fav-delete").onclick = (e) => {
          e.stopPropagation();
          toggleFavoriteStop(s);
        };
        favStopsList.appendChild(item);
        loadSavedStopETA(s.cod);
      });
    }

    // 2. Saved Lines
    if (!favs.lines || favs.lines.length === 0) {
      favLinesList.innerHTML = `<div class="empty-state"><p>Nenhuma linha salva ainda. Toque em um ônibus no mapa e clique em ⭐ Salvar Linha!</p></div>`;
    } else {
      favLinesList.innerHTML = "";
      favs.lines.forEach((l) => {
        const isTracked = l.codIti && activeRoutes.has(parseInt(l.codIti, 10));
        const item = document.createElement("div");
        item.className = "fav-card";
        item.innerHTML = `
          <div class="fav-card-left">
            <span class="fav-card-icon">🚌</span>
            <div style="min-width:0">
              <div class="fav-card-name">${l.code} - ${l.name}</div>
              <div class="fav-card-sub">${l.codIti ? "Traçado disponível" : "Linha favorita"}</div>
            </div>
          </div>
          <div class="fav-card-actions">
            ${l.codIti ? `<button class="btn-small ${isTracked ? "active" : ""}">${isTracked ? "✕ Remover" : "+ Traçar"}</button>` : ""}
            <button class="btn-fav-delete" title="Excluir">✕</button>
          </div>
        `;
        const traceBtn = item.querySelector(".btn-small");
        if (traceBtn && l.codIti) {
          traceBtn.onclick = (e) => {
            e.stopPropagation();
            window.toggleRoute(l.codIti, l.code, l.name);
          };
        }
        item.querySelector(".fav-card-left").onclick = () => {
          if (l.codIti) {
            window.toggleRoute(l.codIti, l.code, l.name);
          } else {
            showToast(`Linha ${l.code}`);
          }
        };
        item.querySelector(".btn-fav-delete").onclick = (e) => {
          e.stopPropagation();
          toggleFavoriteLine(l.code, l.name, l.codIti);
        };
        favLinesList.appendChild(item);
      });
    }
  }

  // --- INITIALIZE RADARMAP ---
  function initMap() {
    if (map) return;

    logMsg("Iniciando RadarMap nativo...");
    let savedLastGps = null;
    try {
      const rawLastGps = localStorage.getItem("busradar_last_gps");
      if (rawLastGps) savedLastGps = JSON.parse(rawLastGps);
    } catch (e) {}
    const initialLat = (savedLastGps && savedLastGps.lat) ? savedLastGps.lat : CANOAS_CENTRO.lat;
    const initialLng = (savedLastGps && savedLastGps.lng) ? savedLastGps.lng : CANOAS_CENTRO.lng;
    if (savedLastGps && savedLastGps.lat && savedLastGps.lng) {
      userCoords = { lat: savedLastGps.lat, lng: savedLastGps.lng };
      if (originMode === "gps") originCoords = { ...userCoords };
    }

    map = new RadarMap("map", {
      center: { lat: initialLat, lng: initialLng },
      zoom: 15
    });

    map.setUserLocation(userCoords.lat, userCoords.lng);
    if (homeCoords) {
      map.setHomeLocation(homeCoords.lat, homeCoords.lng, walkingRadius);
    }
    const initialFavs = getFavorites();
    map.setSavedStops(initialFavs.stops || [], (s) => selectStop(s, false));
    updateRouteUI();

    // Clique no pino do usuário centraliza a tela
    map.onUserLocClick = () => {
      detectUserLocation();
      if (originMode === "gps") {
        originCoords = { ...userCoords };
        updateRouteUI();
        triggerDataRefresh();
      }
      showToast("📍 Centralizado no seu GPS");
      expandPanel();
    };

    // Map click during location picking
    map.on("click", (latLng) => {
      if (pickingTarget) {
        map.setPicker(latLng.lat, latLng.lng, pickingTarget === "home" || pickingTarget === "dest");
      }
    });

    // Detecção exploratória de paradas no centro da tela (~250m de raio) e atualização de paradas das rotas
    let centerStopsDebounce = null;
    map.on("moveend", (center) => {
      if (centerStopsDebounce) clearTimeout(centerStopsDebounce);
      centerStopsDebounce = setTimeout(() => {
        handleCenterExploration(center);
        if (typeof updateRouteStopsWithEtas === "function") {
          updateRouteStopsWithEtas();
        }
      }, 350);
    });

    // No Android APK nativo (window.AndroidBridge), ocultar botões de download de APK
    if (window.AndroidBridge) {
      const dlCards = document.querySelectorAll("#btn-download-apk, #btn-header-download, .btn-download-apk-card");
      dlCards.forEach((el) => {
        el.style.display = "none";
      });
    }

    setupDraggablePanel();
    renderFavoritesTab();
    initTrensurb();
    detectUserLocation();
    triggerDataRefresh();

    setTimeout(() => {
      if (map) map.resize();
    }, 250);
  }

  // --- GPS Location Handling ---
  window.onNativeGpsLocation = function (lat, lng) {
    if (!lat || !lng) return;
    const fLat = parseFloat(lat);
    const fLng = parseFloat(lng);
    if (isNaN(fLat) || isNaN(fLng)) return;

    userCoords = { lat: fLat, lng: fLng };
    try { localStorage.setItem("busradar_last_gps", JSON.stringify(userCoords)); } catch (e) {}
    if (originMode === "gps") {
      originCoords = { lat: fLat, lng: fLng };
      originLabel = "Meu GPS (Posição Atual)";
    }
    if (destMode === "gps") {
      destCoords = { lat: fLat, lng: fLng };
      destLabel = "Meu GPS (Posição Atual)";
    }
    updateRouteUI();
    if (map) {
      map.setUserLocation(userCoords.lat, userCoords.lng);
      if (!hasCenteredOnInitialGps) {
        hasCenteredOnInitialGps = true;
        map.setView(userCoords.lat, userCoords.lng, 16);
      }
    }
    if (statusText) statusText.textContent = "GPS Conectado";
    logMsg(`GPS Nativo recebido: ${fLat.toFixed(5)}, ${fLng.toFixed(5)}`);
    triggerDataRefresh();
  };

  function detectUserLocation() {
    if (statusText) statusText.textContent = "Buscando GPS...";

    // 1. Android Native GPS Provider
    if (window.AndroidBridge && typeof window.AndroidBridge.requestGpsLocation === "function") {
      try {
        logMsg("Solicitando fix via AndroidBridge...");
        window.AndroidBridge.requestGpsLocation();
      } catch (err) {
        logMsg("Erro no AndroidBridge.requestGpsLocation: " + err.message);
      }
    }

    // 2. Browser Geolocation API
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          userCoords = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude
          };
          try { localStorage.setItem("busradar_last_gps", JSON.stringify(userCoords)); } catch (e) {}
          if (originMode === "gps") {
            originCoords = { ...userCoords };
            originLabel = "Meu GPS (Posição Atual)";
          }
          if (destMode === "gps") {
            destCoords = { ...userCoords };
            destLabel = "Meu GPS (Posição Atual)";
          }
          updateRouteUI();
          if (map) {
            map.setUserLocation(userCoords.lat, userCoords.lng);
            if (!hasCenteredOnInitialGps) {
              hasCenteredOnInitialGps = true;
              map.setView(userCoords.lat, userCoords.lng, 16);
            }
          }
          if (statusText) statusText.textContent = "GPS Conectado";
          logMsg(`GPS Web recebido: ${userCoords.lat.toFixed(5)}, ${userCoords.lng.toFixed(5)}`);
          triggerDataRefresh();
        },
        (err) => {
          logMsg(`GPS Web indisponível: ${err.message}. Mantendo Centro de Canoas.`);
          if (statusText) statusText.textContent = "Centro de Canoas";
        },
        { timeout: 7000, enableHighAccuracy: true, maximumAge: 10000 }
      );
    }
  }

  // Radius button selection
  radiusButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      radiusButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      walkingRadius = parseInt(btn.dataset.radius, 10);
      localStorage.setItem("busradar_walk_radius", walkingRadius);
      if (map && homeCoords) {
        map.setHomeRadius(walkingRadius);
      }
      showToast(
        `Raio ajustado para ${walkingRadius >= 1000 ? (walkingRadius / 1000).toFixed(1) + "km" : walkingRadius + "m"}`
      );
      triggerDataRefresh();
    });
  });

  if (btnMyLoc) {
    btnMyLoc.addEventListener("click", () => {
      hasCenteredOnInitialGps = false;
      detectUserLocation();
      if (userCoords && map) {
        map.setView(userCoords.lat, userCoords.lng, 16);
      }
      if (originMode === "gps") {
        originCoords = { ...userCoords };
        updateRouteUI();
        triggerDataRefresh();
      }
      showToast("📍 Centralizado no seu GPS");
      expandPanel();
    });
  }

  if (btnHomeLoc) {
    btnHomeLoc.addEventListener("click", () => {
      if (homeCoords && map) {
        map.setView(homeCoords.lat, homeCoords.lng, 16);
        showToast("🏠 Centralizado em Minha Casa");
        expandPanel();
      } else {
        openLocationPicker("home");
      }
    });
  }

  if (btnRefresh) {
    btnRefresh.addEventListener("click", () => {
      // 1. Limpa caches de busca genéricos e memória persistente de veículos
      lastBusesAroundList = [];
      knownOriginStops.clear();
      knownDestStops.clear();
      routeVehiclesMap.clear();
      persistentVehicleStore.clear();
      itineraryPointsCache.clear();
      if (map && map.ambientRoutes) map.ambientRoutes.clear();

      // 2. Limpa marcadores genéricos do mapa para recarregar do zero
      if (map) {
        map.setStops([], []);
        map.setVehicles([]);
      }

      // 3. PRIORIDADE ABSOLUTA: Aplica imediatamente paradas e linhas salvas
      const favs = getFavorites();
      if (map && favs.stops) {
        map.setSavedStops(favs.stops, (s) => selectStop(s, false));
      }

      showToast("🔄 Atualizando do zero... Priorizando paradas e linhas salvas!");

      // 4. Dispara busca imediata para as linhas favoritas e traçadas
      (favs.lines || []).forEach((l) => {
        if (l.codIti) fetchBusesForIti(l.codIti);
      });
      for (const iti of activeRoutes.keys()) {
        fetchBusesForIti(iti);
      }

      // 5. Atualiza dados gerais de GPS e paradas da região
      triggerDataRefresh();
      expandPanel();
    });
  }

  // --- Location Picker (Preserves current map position without snapping back!) ---
  function openLocationPicker(target) {
    if (!map) return;
    pickingTarget = target;
    pickerBanner.classList.add("active");
    pickerSearchInput.value = "";
    pickerSearchResults.style.display = "none";
    expandPanel();

    if (target === "home") {
      pickerTitle.innerHTML = "🏠 Definindo Sua Casa";
    } else if (target === "origin") {
      pickerTitle.innerHTML = "📍 Definindo Ponto de Origem";
    } else {
      pickerTitle.innerHTML = "🎯 Definindo Ponto de Destino";
    }

    const center = map.getCenter();
    map.setPicker(center.lat, center.lng, target === "home" || target === "dest");
    showToast("Toque no mapa para definir a posição.");
  }

  function closeLocationPicker() {
    pickerBanner.classList.remove("active");
    if (map) map.clearPicker();
    pickingTarget = null;
  }

  // Origem: Pills de Seleção Rápida
  if (btnOrigGps) {
    btnOrigGps.addEventListener("click", (e) => {
      e.stopPropagation();
      originMode = "gps";
      originStop = null;
      if (userCoords) {
        originCoords = { ...userCoords };
        originLabel = "Meu GPS (Posição Atual)";
      } else {
        originLabel = "Buscando GPS...";
      }
      detectUserLocation();
      updateRouteUI();
      showToast("📍 Origem: Meu GPS");
      triggerDataRefresh();
      expandPanel();
    });
  }

  if (btnOrigHome) {
    btnOrigHome.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!homeCoords) {
        showToast("Defina sua casa primeiro no mapa.");
        openLocationPicker("home");
        return;
      }
      originMode = "home";
      originStop = null;
      originCoords = { ...homeCoords };
      originLabel = "Minha Casa";
      updateRouteUI();
      showToast("🏠 Origem: Minha Casa");
      triggerDataRefresh();
      expandPanel();
    });
  }

  if (btnOrigMap) {
    btnOrigMap.addEventListener("click", (e) => {
      e.stopPropagation();
      openLocationPicker("origin");
    });
  }

  // Destino: Pills de Seleção Rápida
  if (btnDestHome) {
    btnDestHome.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!homeCoords) {
        showToast("Defina sua casa primeiro no mapa.");
        openLocationPicker("home");
        return;
      }
      destMode = "home";
      destStop = null;
      destCoords = { ...homeCoords };
      destLabel = "Minha Casa";
      updateRouteUI();
      showToast("🏠 Destino: Minha Casa");
      triggerDataRefresh();
      expandPanel();
    });
  }

  if (btnDestGps) {
    btnDestGps.addEventListener("click", (e) => {
      e.stopPropagation();
      destMode = "gps";
      destStop = null;
      if (userCoords) {
        destCoords = { ...userCoords };
        destLabel = "Meu GPS (Posição Atual)";
      } else {
        destLabel = "Buscando GPS...";
      }
      detectUserLocation();
      updateRouteUI();
      showToast("🎯 Destino: Meu GPS");
      triggerDataRefresh();
      expandPanel();
    });
  }

  if (btnDestMap) {
    btnDestMap.addEventListener("click", (e) => {
      e.stopPropagation();
      openLocationPicker("dest");
    });
  }

  // Inverter Sentido (Origem ⇄ Destino) com 1 toque
  if (btnSwapRoute) {
    btnSwapRoute.addEventListener("click", (e) => {
      e.stopPropagation();
      const tempMode = originMode;
      const tempCoords = originCoords ? { ...originCoords } : null;
      const tempLabel = originLabel;
      const tempStop = originStop;

      originMode = destMode;
      originCoords = destCoords ? { ...destCoords } : null;
      originLabel = destLabel;
      originStop = destStop;

      destMode = tempMode;
      destCoords = tempCoords;
      destLabel = tempLabel;
      destStop = tempStop;

      updateRouteUI();
      showToast("⇅ Sentido invertido!");
      triggerDataRefresh();
      expandPanel();
    });
  }

  // Quick Action Buttons on Selected Stop (Tab 2)
  if (btnSetStopOrig) {
    btnSetStopOrig.addEventListener("click", () => {
      if (!currentSelectedStop) return;
      originMode = "stop";
      originStop = currentSelectedStop;
      originCoords = { lat: currentSelectedStop.y, lng: currentSelectedStop.x };
      const stopName = (currentSelectedStop.desc || `Parada ${currentSelectedStop.cod}`).split("-")[0].trim();
      originLabel = `🚏 ${stopName}`;
      updateRouteUI();
      showToast(`📍 Origem definida para: ${stopName}`);
      switchTab("tab-home");
      triggerDataRefresh();
      expandPanel();
    });
  }

  if (btnSetStopDest) {
    btnSetStopDest.addEventListener("click", () => {
      if (!currentSelectedStop) return;
      destMode = "stop";
      destStop = currentSelectedStop;
      destCoords = { lat: currentSelectedStop.y, lng: currentSelectedStop.x };
      const stopName = (currentSelectedStop.desc || `Parada ${currentSelectedStop.cod}`).split("-")[0].trim();
      destLabel = `🎯 ${stopName}`;
      updateRouteUI();
      showToast(`🎯 Destino definido para: ${stopName}`);
      switchTab("tab-home");
      triggerDataRefresh();
      expandPanel();
    });
  }

  // Home Favorites Management (Tab 4)
  if (btnConfigHomeFav) {
    btnConfigHomeFav.addEventListener("click", () => {
      openLocationPicker("home");
    });
  }

  if (btnUseHomeAsDest) {
    btnUseHomeAsDest.addEventListener("click", () => {
      if (!homeCoords) {
        showToast("Defina sua casa primeiro no mapa.");
        openLocationPicker("home");
        return;
      }
      destMode = "home";
      destStop = null;
      destCoords = { ...homeCoords };
      destLabel = "Minha Casa";
      updateRouteUI();
      switchTab("tab-home");
      showToast("🏠 Destino alterado para Minha Casa!");
      triggerDataRefresh();
      expandPanel();
    });
  }

  if (btnUseHomeAsOrig) {
    btnUseHomeAsOrig.addEventListener("click", () => {
      if (!homeCoords) {
        showToast("Defina sua casa primeiro no mapa.");
        openLocationPicker("home");
        return;
      }
      originMode = "home";
      originStop = null;
      originCoords = { ...homeCoords };
      originLabel = "Minha Casa";
      updateRouteUI();
      switchTab("tab-home");
      showToast("🏠 Origem alterada para Minha Casa!");
      triggerDataRefresh();
      expandPanel();
    });
  }

  // Setup rows click
  document.querySelectorAll(".setup-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      expandPanel();
      if (!e.target.closest("button")) {
        if (row.id === "row-dest") {
          openLocationPicker("dest");
        } else if (row.id === "row-origin") {
          openLocationPicker("origin");
        }
      }
    });
  });

  if (pickerBtnCancel) {
    pickerBtnCancel.addEventListener("click", () => {
      closeLocationPicker();
      expandPanel();
    });
  }

  if (pickerBtnSave) {
    pickerBtnSave.addEventListener("click", () => {
      if (!map || !map.pickerPos) return;
      const pos = map.pickerPos;

      if (pickingTarget === "home") {
        homeCoords = { lat: pos.lat, lng: pos.lng };
        localStorage.setItem("busradar_home_coords", JSON.stringify(homeCoords));
        if (destMode === "home") {
          destCoords = { ...homeCoords };
          destLabel = "Minha Casa";
        }
        if (originMode === "home") {
          originCoords = { ...homeCoords };
          originLabel = "Minha Casa";
        }
        map.setHomeLocation(homeCoords.lat, homeCoords.lng, walkingRadius);
        showToast("✓ Local de Casa salvo com sucesso!");
      } else if (pickingTarget === "origin") {
        originMode = "custom";
        originStop = null;
        originCoords = { lat: pos.lat, lng: pos.lng };
        originLabel = `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`;
        if (map) map.setUserLocation(originCoords.lat, originCoords.lng);
        showToast("✓ Ponto de origem atualizado!");
      } else if (pickingTarget === "dest") {
        destMode = "custom";
        destStop = null;
        destCoords = { lat: pos.lat, lng: pos.lng };
        destLabel = `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`;
        showToast("✓ Ponto de destino atualizado!");
      }

      updateRouteUI();
      closeLocationPicker();
      expandPanel();
      triggerDataRefresh();
    });
  }

  if (pickerBtnGps) {
    pickerBtnGps.addEventListener("click", () => {
      if (userCoords && map) {
        map.setPicker(userCoords.lat, userCoords.lng, pickingTarget === "home" || pickingTarget === "dest");
        map.setView(userCoords.lat, userCoords.lng, 16);
      }
    });
  }

  // Address search via Nominatim
  if (pickerSearchInput) {
    pickerSearchInput.addEventListener("input", (e) => {
      clearTimeout(searchDebounceTimer);
      const query = e.target.value.trim();
      if (query.length < 3) {
        pickerSearchResults.style.display = "none";
        return;
      }

      searchDebounceTimer = setTimeout(async () => {
        try {
          const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=br&limit=5&q=${encodeURIComponent(query)}`;
          const res = await fetch(url);
          const results = await res.json();

          if (results.length === 0) {
            pickerSearchResults.style.display = "none";
            return;
          }

          pickerSearchResults.innerHTML = "";
          results.forEach((item) => {
            const div = document.createElement("div");
            div.className = "search-result-item";
            div.textContent = item.display_name;
            div.onclick = () => {
              const lat = parseFloat(item.lat);
              const lng = parseFloat(item.lon);
              if (map) {
                map.setPicker(lat, lng, pickingTarget === "home" || pickingTarget === "dest");
                map.setView(lat, lng, 16);
              }
              pickerSearchResults.style.display = "none";
              pickerSearchInput.value = item.display_name.split(",")[0];
            };
            pickerSearchResults.appendChild(div);
          });

          pickerSearchResults.style.display = "block";
        } catch (err) {}
      }, 400);
    });
  }

  // --- Main Data Refresh & Matching Engine ---
  let tripMatchesCalculated = false;

  function triggerDataRefresh() {
    if (isFetching) return;
    isFetching = true;
    if (btnRefresh) btnRefresh.classList.add("spinning");

    const center = map ? map.getCenter() : (originCoords || userCoords || CANOAS_CENTRO);
    fetchBusesAround(center.lat, center.lng);

    for (const iti of activeRoutes.keys()) {
      fetchBusesForIti(iti);
    }

    const favs = getFavorites();
    (favs.lines || []).forEach((l) => {
      if (l.codIti && !activeRoutes.has(l.codIti)) {
        fetchBusesForIti(l.codIti);
      }
    });

    if (destCoords && originCoords && tripMatchesCalculated) {
      fetchTripMatches();
    } else if (originCoords) {
      fetchStopsForRegion(originCoords.lat, originCoords.lng);
      if (activeBusesCount && !tripMatchesCalculated) {
        activeBusesCount.textContent = "🎯 Toque em IR para traçar rotas";
      }
      isFetching = false;
      if (btnRefresh) btnRefresh.classList.remove("spinning");
    } else {
      isFetching = false;
      if (btnRefresh) btnRefresh.classList.remove("spinning");
    }
  }

  // Client-Side Matching (Suporta GPS, Casa, Parada Selecionada e Ponto Customizado)
  async function runClientSideMatch(origCoords, destCoords, radius, forcedOrigStop = null, forcedDestStop = null) {
    try {
      let origStops = [];
      let destStops = [];
      const destCodes = new Set();
      const destStopsMap = new Map();

      // 1. Destination Stops
      if (forcedDestStop) {
        const stopObj = { ...forcedDestStop, distance_to_dest_m: 0, isDest: true };
        destStops = [stopObj];
        destCodes.add(forcedDestStop.cod);
        destStopsMap.set(forcedDestStop.cod, stopObj);
      } else if (destCoords) {
        const destUrl = `${SIU_BASE}/V3/buscarParadasProximas/${destCoords.lng}/${destCoords.lat}/0/POA/retornoJSONH`;
        const destData = await smartFetch(destUrl, true);
        const rawDest = destData.paradas || [];
        rawDest.forEach((s) => {
          const d = calcDistanceMeters(destCoords.lat, destCoords.lng, s.y, s.x);
          if (d <= radius) {
            const stopObj = { ...s, distance_to_dest_m: Math.round(d), isDest: true };
            destStops.push(stopObj);
            destCodes.add(s.cod);
            destStopsMap.set(s.cod, stopObj);
          }
        });
      }

      // 2. Origin Stops
      if (forcedOrigStop) {
        origStops = [{ ...forcedOrigStop, distance_to_orig_m: 0 }];
      } else if (origCoords) {
        const origUrl = `${SIU_BASE}/V3/buscarParadasProximas/${origCoords.lng}/${origCoords.lat}/0/POA/retornoJSONH`;
        const origData = await smartFetch(origUrl, true);
        const rawOrig = origData.paradas || [];
        origStops = rawOrig.slice(0, 10);
      }

      if (origStops.length === 0 || destStops.length === 0) {
        return { matches: [], orig_stops: origStops, dest_stops: destStops, vehicles: {} };
      }

      const busCandidates = [];
      const itisToCheck = new Set();

      const prevPromises = origStops.slice(0, 5).map(async (st) => {
        try {
          const pUrl = `${SIU_BASE}/V3/buscarPrevisoes/${st.cod}/false/0/POA/retornoJSON`;
          const pData = await smartFetch(pUrl, true);
          (pData.previsoes || []).forEach((p) => {
            if (p.codItinerario) {
              busCandidates.push({ ...p, orig_stop: st });
              itisToCheck.add(p.codItinerario);
            }
          });
        } catch (e) {}
      });
      await Promise.all(prevPromises);

      const itiPromises = [...itisToCheck].map(async (iti) => {
        if (itiStopsCache.has(iti)) return;
        try {
          const itiUrl = `${SIU_BASE}/buscarParadasPorItiComCoordenadas/${iti}/0/retornoJSONPontosItinerario`;
          const itiData = await smartFetch(itiUrl, true);
          if (itiData.paradas && itiData.paradas.length > 0) {
            itiStopsCache.set(iti, itiData.paradas);
          }
        } catch (e) {}
      });
      await Promise.all(itiPromises);

      const matchedBuses = [];
      const matchedItis = new Set();

      busCandidates.forEach((item) => {
        const iti = item.codItinerario;
        const origCod = item.orig_stop.cod;
        const seq = itiStopsCache.get(iti) || [];

        let origIdx = -1;
        let destMatch = null;

        for (let i = 0; i < seq.length; i++) {
          if (seq[i].cod == origCod && origIdx === -1) {
            origIdx = i;
          } else if (origIdx !== -1 && destCodes.has(seq[i].cod)) {
            destMatch = destStopsMap.get(seq[i].cod) || seq[i];
            break;
          }
        }

        if (origIdx !== -1 && destMatch) {
          matchedItis.add(iti);
          matchedBuses.push({
            ...item,
            dest_stop: destMatch
          });
        }
      });

      const vehiclesMap = {};
      const vPromises = [...matchedItis].map(async (iti) => {
        try {
          const vUrl = `${SIU_BASE}/V3/retornaVeiculosMapa/${iti}/0/POA/retornoJSONVeiculos`;
          const vRes = await smartFetch(vUrl, true);
          vehiclesMap[iti] = vRes.veiculos || [];
        } catch (e) {}
      });
      await Promise.all(vPromises);

      return {
        matches: matchedBuses,
        orig_stops: origStops,
        dest_stops: destStops,
        vehicles: vehiclesMap
      };
    } catch (e) {
      return { matches: [], orig_stops: [], dest_stops: [], vehicles: {} };
    }
  }

  async function fetchTripMatches() {
    if (!originCoords || !destCoords) {
      if (originCoords) {
        fetchStopsForRegion(originCoords.lat, originCoords.lng);
      }
      return;
    }

    try {
      let data = null;

      if (window.location.protocol.startsWith("http")) {
        try {
          const endpoint = `/api/match?origLat=${originCoords.lat}&origLng=${originCoords.lng}&destLat=${destCoords.lat}&destLng=${destCoords.lng}&destRadius=${walkingRadius}`;
          data = await smartFetch(endpoint);
        } catch (e) {}
      }

      if (!data || !data.matches) {
        data = await runClientSideMatch(originCoords, destCoords, walkingRadius, originStop, destStop);
      }

      currentMatches = data.matches || [];
      if (activeBusesCount) {
        const destTitle = destMode === "home" ? "pra casa" : "ao destino";
        activeBusesCount.textContent = `🚌 ${currentMatches.length} opções ${destTitle}`;
      }

      if (map) {
        if (data.orig_stops && data.orig_stops.length > 0) {
          data.orig_stops.forEach((s) => {
            const sLat = parseFloat(s.lat !== undefined ? s.lat : s.y);
            const sLng = parseFloat(s.lng !== undefined ? s.lng : s.x);
            s.lat = sLat; s.lng = sLng; s.y = sLat; s.x = sLng;
            knownOriginStops.set(s.cod, s);
          });
        }
        if (data.dest_stops && data.dest_stops.length > 0) {
          data.dest_stops.forEach((s) => {
            const sLat = parseFloat(s.lat !== undefined ? s.lat : s.y);
            const sLng = parseFloat(s.lng !== undefined ? s.lng : s.x);
            s.lat = sLat; s.lng = sLng; s.y = sLat; s.x = sLng;
            knownDestStops.set(s.cod, s);
          });
        }
        const origList = (data.orig_stops && data.orig_stops.length > 0) ? data.orig_stops : Array.from(knownOriginStops.values());
        const destList = (data.dest_stops && data.dest_stops.length > 0) ? data.dest_stops : Array.from(knownDestStops.values());
        map.setStops(origList, destList, (stop) => selectStop(stop, stop.isDest));
        if (data.vehicles && typeof data.vehicles === "object") {
          const tripVeics = [];
          Object.keys(data.vehicles).forEach((iti) => {
            (data.vehicles[iti] || []).forEach((v) => tripVeics.push({ ...v, codIti: iti }));
          });
          if (tripVeics.length > 0) {
            lastBusesAroundList = tripVeics;
          }
        }
        mergeAndRenderVehicles();
      }
      renderTripMatchesList();
    } catch (err) {
      logMsg("Erro em fetchTripMatches: " + err.message);
    } finally {
      isFetching = false;
      if (btnRefresh) btnRefresh.classList.remove("spinning");
    }
  }
  const fetchHomeMatches = fetchTripMatches;

  function renderTripMatchesList() {
    if (!homeBusList) return;
    const radLabel = walkingRadius >= 1000 ? `${(walkingRadius / 1000).toFixed(1)}km` : `${walkingRadius}m`;
    const destName = destMode === "home" ? "casa" : "destino";

    // 1. Informações dos trens em tempo real para a rota multimodal
    const trains = typeof calculateTrensurbTrains === "function" ? calculateTrensurbTrains() : [];
    const nextSouthTrain = trains.find((t) => !t.isNorth);
    const nextTrainIsNew = nextSouthTrain && nextSouthTrain.isNewModel;
    const trainModelGlass = nextTrainIsNew
      ? `<span class="train-glass-tag glass-yellow" style="position:static;display:inline-block;padding:1px 6px;margin-left:4px;">❄️ AR NOVO</span>`
      : `<span class="train-glass-tag glass-white" style="position:static;display:inline-block;padding:1px 6px;margin-left:4px;">💨 S100</span>`;
    const nextEtaStr = nextSouthTrain ? `Trem chegando em ~${nextSouthTrain.etaMin} min` : "Trens a cada 10-12 min";

    // Detecta se a viagem se beneficia do corredor multimodal metropolitano (Canoas ⇄ Porto Alegre / Mercado)
    const isCanoasOrig = originCoords && originCoords.lat > -29.99;
    const isPoaDest = destCoords && destCoords.lat <= -29.99;
    const isCorridorTrip = isCanoasOrig && (isPoaDest || (destLabel || "").toLowerCase().includes("mercado") || (destLabel || "").toLowerCase().includes("trabalho") || (destLabel || "").toLowerCase().includes("poa") || (destLabel || "").toLowerCase().includes("estação"));

    let multimodalHtml = "";
    if (showTrensurb) {
      if (isCorridorTrip) {
        multimodalHtml = `
        <div class="multimodal-trip-card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <span style="font-weight:800;font-size:0.88rem;color:#38bdf8;">⚡ Rota Integrada Mais Rápida (Ônibus + Metrô)</span>
            <span style="background:#10b981;color:#fff;font-size:0.65rem;padding:2px 7px;border-radius:10px;font-weight:800;">Economize ~40 min</span>
          </div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px;">
            <span style="font-size:1.25rem;font-weight:900;color:#fff;">~34 min</span>
            <span style="font-size:0.72rem;color:#94a3b8;">vs 1h 15 min no trânsito rodoviário</span>
          </div>

          <div class="multimodal-step-row">
            <div class="multimodal-step-icon">🚶‍♂️</div>
            <div style="flex:1;">
              <div style="font-weight:700;font-size:0.78rem;color:#fff;">Caminhada até parada local</div>
              <div style="font-size:0.68rem;color:#94a3b8;">~2 min a pé até Rua Açucena / Mathias Velho</div>
            </div>
          </div>

          <div class="multimodal-step-row">
            <div class="multimodal-step-icon">🚌</div>
            <div style="flex:1;">
              <div style="font-weight:700;font-size:0.78rem;color:#fff;">Ônibus Local (5106 / TM2 / 5103) até Estação de Trem</div>
              <div style="font-size:0.68rem;color:#cbd5e1;">Desembarque na <b>Estação Mathias Velho</b> ou <b>Canoas</b> (~12 min)</div>
            </div>
          </div>

          <div class="multimodal-step-row">
            <div class="multimodal-step-icon">🚈</div>
            <div style="flex:1;">
              <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-weight:800;font-size:0.8rem;color:#38bdf8;">Trensurb Sentido Sul (Mercado)</span>
                ${trainModelGlass}
              </div>
              <div style="font-size:0.68rem;color:#cbd5e1;">${nextEtaStr} • 18 min expressos sem trânsito até Porto Alegre</div>
            </div>
          </div>

          <div class="multimodal-step-row" style="padding-bottom:0;">
            <div class="multimodal-step-icon" style="background:#10b981;border-color:#10b981;color:#fff;">🏁</div>
            <div style="flex:1;">
              <div style="font-weight:700;font-size:0.78rem;color:#fff;">Chegada no Destino (Estação Mercado / Porto Alegre)</div>
              <div style="font-size:0.68rem;color:#94a3b8;">Desembarque rápido no Centro de Porto Alegre</div>
            </div>
          </div>

          <div style="margin-top:10px;display:flex;gap:6px;">
            <button class="btn-primary" style="flex:1;background:#0284c7;padding:7px;font-size:0.75rem;border-radius:8px;" onclick="window.traceIntegratedMultimodalRoute()">
              🗺 Traçar Rota Integrada no Mapa
            </button>
          </div>
        </div>
      `;
      } else {
        multimodalHtml = `
        <div class="trensurb-route-card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <span style="font-weight:800;font-size:0.88rem;color:#38bdf8;">🚈 Linha 1 Trensurb (Metrô POA ⇄ Canoas)</span>
            <span style="background:#0284c7;color:#fff;font-size:0.65rem;padding:2px 6px;border-radius:6px;font-weight:700;">Alta Frequência</span>
          </div>
          <div style="font-size:0.75rem;color:#cbd5e1;margin-bottom:8px;">
            Ligação expressa Canoas ⇄ Mercado (~18 min). Trens com ar condicionado a cada 10-12 min.
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn-primary" style="flex:1;padding:6px;font-size:0.75rem;background:#0284c7;border-radius:8px;" onclick="window.focusTrensurbTrack()">🗺 Ver Estações e Trens no Mapa</button>
          </div>
        </div>
      `;
      }
    }

    if (currentMatches.length === 0) {
      homeBusList.innerHTML = `
        ${multimodalHtml}
        <div class="empty-state">
          <p>Nenhum ônibus em circulação direta agora das paradas de Origem até ${radLabel} a pé do ${destName}.</p>
          ${showTrensurb ? '<small style="color:var(--text-muted)">Utilize a Rota Integrada Ônibus + Metrô Trensurb acima para chegar rapidamente sem trânsito.</small>' : ''}
        </div>
      `;
      return;
    }

    homeBusList.innerHTML = multimodalHtml;
    currentMatches.forEach((m) => {
      const isSoon = m.prev && (m.prev.includes("1 ") || m.prev.includes("2 ") || m.prev.includes("3 ") || m.prev.includes("Minutos"));
      const isTracked = m.codItinerario && activeRoutes.has(parseInt(m.codItinerario, 10));
      const walkM = m.dest_stop && m.dest_stop.distance_to_dest_m ? `${m.dest_stop.distance_to_dest_m}m a pé de ${destName}` : "";

      const card = document.createElement("div");
      card.className = "bus-card";
      card.innerHTML = `
        <div class="bus-header">
          <span class="bus-badge">${m.sgLin || "LINHA"}</span>
          <span class="bus-eta ${isSoon ? "soon" : ""}">⏱️ ${m.prev || "Em trânsito"}</span>
        </div>
        <div class="bus-name">${m.apelidoLinha || m.sgLin}</div>
        <div class="bus-route-path">
          <div>🚏 <b>Embarque:</b> ${(m.orig_stop ? m.orig_stop.desc : "").split("-")[0]}</div>
          <div>🏁 <b>Descida:</b> ${(m.dest_stop ? m.dest_stop.desc : "").split("-")[0]} <span style="color:var(--accent-light);font-weight:bold">${walkM ? `(${walkM})` : ""}</span></div>
        </div>
        <div class="bus-footer">
          <span>Veículo: <b>${m.numVeicGestor || "GPS Ativo"}</b></span>
          ${
            m.codItinerario
              ? `<button class="btn-trace ${isTracked ? "active" : ""}" data-trace-iti="${m.codItinerario}" onclick="window.toggleRoute(${m.codItinerario}, '${m.sgLin || ""}', '${m.apelidoLinha || ""}')">
                  ${isTracked ? "✕ Remover" : "+ Traçar"}
                 </button>`
              : ""
          }
        </div>
      `;
      homeBusList.appendChild(card);
    });
  }
  const renderHomeMatchesList = renderTripMatchesList;

  const knownOriginStops = new Map();
  const knownDestStops = new Map();

  async function fetchStopsForRegion(lat, lng) {
    try {
      const fallbackUrl = `${SIU_BASE}/V3/buscarParadasProximas/${lng}/${lat}/0/POA/retornoJSONH`;
      const data = await smartFetch(fallbackUrl, true);
      const rawStops = data.stops || data.paradas || [];
      rawStops.forEach((s) => {
        const sLat = parseFloat(s.lat !== undefined ? s.lat : s.coordY !== undefined ? s.coordY : s.y);
        const sLng = parseFloat(s.lng !== undefined ? s.lng : s.coordX !== undefined ? s.coordX : s.x);
        if (isNaN(sLat) || isNaN(sLng)) return;
        s.lat = sLat;
        s.lng = sLng;
        s.y = sLat;
        s.x = sLng;
        s.desc = s.desc || s.descricao || `Parada ${s.cod}`;
        s.descricao = s.desc;
        const dist = calcDistanceMeters(lat, lng, sLat, sLng);
        s.dist = dist;
        if (walkingRadius <= 0 || dist <= walkingRadius + 40) {
          knownOriginStops.set(s.cod, s);
        }
      });

      // Retém as paradas acumuladas na tela para NUNCA sumirem durante o carregamento
      const stopsToRender = Array.from(knownOriginStops.values()).filter((s) => {
        if (walkingRadius <= 0) return true;
        return calcDistanceMeters(lat, lng, s.y, s.x) <= walkingRadius + 40;
      });

      if (map) {
        map.setStops(stopsToRender, Array.from(knownDestStops.values()), (stop) => selectStop(stop, false));
      }
    } catch (e) {
      logMsg("Erro fetchStopsForRegion: " + e.message);
    } finally {
      isFetching = false;
      if (btnRefresh) btnRefresh.classList.remove("spinning");
    }
  }

  let lastCenterStopsCoords = null;
  async function fetchCenterStops(lat, lng, radius = 250) {
    if (!map) return;
    try {
      lastCenterStopsCoords = { lat, lng };
      const centerUrl = `${SIU_BASE}/V3/buscarParadasProximas/${lng}/${lat}/0/POA/retornoJSONH`;
      const data = await smartFetch(centerUrl, true);
      const rawList = data.stops || data.paradas || [];
      const filtered = [];
      rawList.forEach((s) => {
        const sLat = parseFloat(s.lat !== undefined ? s.lat : s.coordY !== undefined ? s.coordY : s.y);
        const sLng = parseFloat(s.lng !== undefined ? s.lng : s.coordX !== undefined ? s.coordX : s.x);
        if (isNaN(sLat) || isNaN(sLng)) return;
        const dist = calcDistanceMeters(lat, lng, sLat, sLng);
        if (dist <= radius) {
          filtered.push({
            cod: s.cod,
            desc: s.desc || s.descricao || `Parada ${s.cod}`,
            descricao: s.descricao || s.desc || `Parada ${s.cod}`,
            x: sLng,
            y: sLat,
            dist
          });
        }
      });
      filtered.sort((a, b) => a.dist - b.dist);
      map.setCenterStops(filtered.slice(0, 10), (stop) => selectStop(stop, false));
    } catch (e) {
      logMsg("Erro ao buscar paradas no centro da tela: " + e.message);
    }
  }

  function handleCenterExploration(center) {
    if (!center || !center.lat || !center.lng || !map) return;
    // Exibir paradas no centro SOMENTE quando o zoom for bem próximo às ruas (zoom >= 16)
    if (map.getZoom() < 16) {
      if (map.centerStops && map.centerStops.length > 0) {
        map.setCenterStops([]);
      }
      return;
    }
    const distToOrig = originCoords ? calcDistanceMeters(center.lat, center.lng, originCoords.lat, originCoords.lng) : 9999;
    const distToDest = destCoords ? calcDistanceMeters(center.lat, center.lng, destCoords.lat, destCoords.lng) : 9999;
    if (distToOrig < 180 || distToDest < 180) {
      map.setCenterStops([]);
      return;
    }
    fetchCenterStops(center.lat, center.lng, 180);
  }

  window.setStopAsOrigin = function (cod, lat, lng, desc) {
    originCoords = { lat: parseFloat(lat), lng: parseFloat(lng) };
    originLabel = (desc || `Parada ${cod}`).split("-")[0].trim();
    originMode = "stop";
    forcedOriginStop = { cod, lat: originCoords.lat, lng: originCoords.lng, desc: originLabel };
    updateRouteUI();
    triggerDataRefresh();
    showToast(`📍 Origem definida: ${originLabel}`);
    if (map) {
      map.setUserLocation(originCoords.lat, originCoords.lng);
      map.setCenterStops([]);
    }
    expandPanel();
  };

  window.setStopAsDest = function (cod, lat, lng, desc) {
    destCoords = { lat: parseFloat(lat), lng: parseFloat(lng) };
    destLabel = (desc || `Parada ${cod}`).split("-")[0].trim();
    destMode = "stop";
    forcedDestStop = { cod, lat: destCoords.lat, lng: destCoords.lng, desc: destLabel };
    updateRouteUI();
    triggerDataRefresh();
    showToast(`🏁 Destino definido: ${destLabel}`);
    if (map) {
      map.setHomeLocation(destCoords.lat, destCoords.lng, walkingRadius);
      map.setCenterStops([]);
    }
    expandPanel();
  };

  window.traceIntegratedMultimodalRoute = async function () {
    let feederIti = null;
    let feederCode = "5106";
    let feederName = "Mathias Velho / Açucena";

    if (currentMatches && currentMatches.length > 0) {
      const match =
        currentMatches.find(
          (m) =>
            (m.sgLin || "").includes("5106") ||
            (m.sgLin || "").includes("5103") ||
            (m.sgLin || "").includes("TM2") ||
            (m.sgLin || "").includes("5104")
        ) || currentMatches[0];

      if (match && match.codItinerario) {
        feederIti = match.codItinerario;
        feederCode = match.sgLin || "Alimentador";
        feederName = match.apelidoLinha || "Mathias Velho";
      }
    }

    if (feederIti && typeof window.toggleRoute === "function") {
      if (!activeRoutes.has(parseInt(feederIti, 10))) {
        await window.toggleRoute(feederIti, feederCode, feederName);
      }
    }

    if (map) {
      map.setView(-29.96, -51.19, 12);
    }
    showToast("⚡ Rota Integrada: Ônibus Local + Metrô Trensurb Sul (18 min sem trânsito)!");
  };

  const routeVehiclesMap = new Map();
  let lastBusesAroundList = [];
  const vehiclePositionHistory = new Map();

  function calculateBearing(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const deltaLambda = toRad(lon2 - lon1);
    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
    const theta = Math.atan2(y, x);
    return Math.round((toDeg(theta) + 360) % 360);
  }

  function getRouteHeadingForBus(lat, lng, routePoints) {
    if (!routePoints || routePoints.length < 2) return null;
    let bestIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < routePoints.length - 1; i++) {
      const p = routePoints[i];
      const d = calcDistanceMeters(lat, lng, p.lat, p.lng);
      if (d < minDist) {
        minDist = d;
        bestIdx = i;
      }
    }
    const p1 = routePoints[bestIdx];
    const p2 = routePoints[Math.min(bestIdx + 1, routePoints.length - 1)];
    return calculateBearing(p1.lat, p1.lng, p2.lat, p2.lng);
  }

  function enrichVehicleWithHeading(v, codIti = null) {
    const vLat = parseFloat(v.lat);
    const vLng = parseFloat(v.long !== undefined ? v.long : v.lng);
    if (isNaN(vLat) || isNaN(vLng)) return v;

    const id = v.numVeicGestor || v.veiculo || v.prefixo || `${vLat}_${vLng}`;
    const prev = vehiclePositionHistory.get(id);

    let heading = null;
    if (prev) {
      const dist = calcDistanceMeters(prev.lat, prev.lng, vLat, vLng);
      if (dist >= 4) {
        heading = calculateBearing(prev.lat, prev.lng, vLat, vLng);
      } else {
        heading = prev.heading;
      }
    }

    if (heading === null && v.direcao !== undefined && v.direcao !== null && !isNaN(v.direcao)) {
      const dirNum = parseInt(v.direcao, 10);
      if (dirNum >= 1 && dirNum <= 8) {
        heading = (dirNum - 1) * 45;
      } else if (dirNum >= 0 && dirNum <= 7) {
        heading = dirNum * 45;
      } else if (dirNum > 8 && dirNum <= 360) {
        heading = dirNum;
      }
    }

    if (heading === null) {
      const targetIti = codIti || v.codIti;
      if (targetIti && activeRoutes.has(targetIti)) {
        heading = getRouteHeadingForBus(vLat, vLng, activeRoutes.get(targetIti).points);
      }
    }

    v.heading = heading;
    vehiclePositionHistory.set(id, { lat: vLat, lng: vLng, heading });
    return v;
  }

  function updateRouteStopsWithEtas() {
    if (!map) return;
    if (activeRoutes.size === 0) {
      map.setRouteStops([]);
      return;
    }

    // Apenas exibe as paradas da linha ao dar zoom (zoom >= 15)
    if (map.getZoom() < 15) {
      map.setRouteStops([]);
      return;
    }

    const seenStops = new Map();

    for (const [codIti, r] of activeRoutes.entries()) {
      const stops = r.stops || [];
      if (stops.length === 0) continue;
      const veics = routeVehiclesMap.get(codIti) || [];

      // Distâncias cumulativas ao longo das paradas
      const cumDists = [0];
      for (let i = 1; i < stops.length; i++) {
        cumDists[i] = cumDists[i - 1] + calcDistanceMeters(stops[i - 1].y, stops[i - 1].x, stops[i].y, stops[i].x);
      }

      stops.forEach((s, sIdx) => {
        const sLat = parseFloat(s.y !== undefined ? s.y : s.lat);
        const sLng = parseFloat(s.x !== undefined ? s.x : s.lng);
        let minEtaMins = null;

        veics.forEach((v) => {
          const vLat = parseFloat(v.lat);
          const vLng = parseFloat(v.long !== undefined ? v.long : v.lng);
          if (isNaN(vLat) || isNaN(vLng)) return;

          const directDist = calcDistanceMeters(vLat, vLng, sLat, sLng);

          // 1. Proximidade Física Direta (Se o ônibus estiver a menos de 1.4 km da parada)
          if (directDist <= 250) {
            const eta = 1;
            if (minEtaMins === null || eta < minEtaMins) minEtaMins = eta;
            return;
          } else if (directDist <= 550) {
            const eta = 2;
            if (minEtaMins === null || eta < minEtaMins) minEtaMins = eta;
            return;
          } else if (directDist <= 950) {
            const eta = 3;
            if (minEtaMins === null || eta < minEtaMins) minEtaMins = eta;
            return;
          } else if (directDist <= 1400) {
            const eta = 4;
            if (minEtaMins === null || eta < minEtaMins) minEtaMins = eta;
            return;
          }

          // 2. Ao longo das paradas do itinerário
          let vClosestIdx = 0;
          let vMinDist = Infinity;
          stops.forEach((st, idx) => {
            const d = calcDistanceMeters(vLat, vLng, st.y, st.x);
            if (d < vMinDist) {
              vMinDist = d;
              vClosestIdx = idx;
            }
          });

          const isReverseDirection = Boolean(r.reverseFlow);
          let stopsAhead = 0;
          let distAlong = 0;

          if (!isReverseDirection && sIdx >= vClosestIdx) {
            stopsAhead = sIdx - vClosestIdx;
            distAlong = (cumDists[sIdx] - cumDists[vClosestIdx]) + vMinDist;
          } else if (isReverseDirection && sIdx <= vClosestIdx) {
            stopsAhead = vClosestIdx - sIdx;
            distAlong = (cumDists[vClosestIdx] - cumDists[sIdx]) + vMinDist;
          } else if (directDist <= 2400) {
            distAlong = directDist * 1.35;
            stopsAhead = Math.abs(sIdx - vClosestIdx);
          } else {
            return;
          }

          const eta = Math.max(1, Math.round(distAlong / 400 + stopsAhead * 0.4));
          if (minEtaMins === null || eta < minEtaMins) {
            minEtaMins = eta;
          }
        });

        const lineBadge = {
          lineCode: r.lineCode,
          color: r.color,
          etaMins: minEtaMins
        };

        const existing = seenStops.get(s.cod);
        if (!existing) {
          seenStops.set(s.cod, {
            cod: s.cod,
            lat: sLat,
            lng: sLng,
            desc: s.desc || `Parada ${s.cod}`,
            lines: [lineBadge],
            routeColor: r.color
          });
        } else {
          existing.lines.push(lineBadge);
        }
      });
    }

    map.setRouteStops([...seenStops.values()], (stop) => selectStop(stop, false));
  }

  // --- MEMÓRIA PERSISTENTE DE ÔNIBUS (Zero piscada / Nunca desaparecem) ---
  const persistentVehicleStore = new Map();
  const itineraryPointsCache = new Map();

  function recordVehiclesInPersistentStore(veicsList) {
    if (!veicsList || !Array.isArray(veicsList)) return;
    const now = Date.now();
    for (const v of veicsList) {
      const vLat = parseFloat(v.lat);
      const vLng = parseFloat(v.long !== undefined ? v.long : v.lng);
      if (isNaN(vLat) || isNaN(vLng)) continue;

      const id = v.numVeicGestor || v.veiculo || v.prefixo || `${vLat}_${vLng}`;
      const existing = persistentVehicleStore.get(id);
      if (existing) {
        existing.lat = vLat;
        existing.long = vLng;
        existing.vel = v.vel !== undefined ? v.vel : existing.vel;
        if (v.heading !== null && v.heading !== undefined) existing.heading = v.heading;
        if (v.direcao !== undefined) existing.direcao = v.direcao;
        if (v.codIti) existing.codIti = v.codIti;
        if (v.descricao) existing.descricao = v.descricao;
        if (v.sgLin) existing.sgLin = v.sgLin;
        existing.lastSeen = now;
      } else {
        persistentVehicleStore.set(id, { ...v, lat: vLat, long: vLng, lastSeen: now });
      }
    }

    // Limpa veículos que não transmitem sinal há mais de 12 minutos
    for (const [id, v] of persistentVehicleStore.entries()) {
      if (now - (v.lastSeen || 0) > 12 * 60 * 1000) {
        persistentVehicleStore.delete(id);
      }
    }
  }

  async function updateAmbientCorridors(vehicles) {
    if (!map || !map.showFleetCorridors || map.getZoom() < 15) {
      if (map && map.ambientRoutes && map.ambientRoutes.size > 0) {
        map.ambientRoutes.clear();
        map.renderSvg();
      }
      return;
    }

    const visibleItis = new Set();
    const veicList = vehicles || map.vehicles || [];
    for (const v of veicList) {
      if (v.codIti && !activeRoutes.has(parseInt(v.codIti, 10)) && !activeRoutes.has(v.codIti)) {
        visibleItis.add(parseInt(v.codIti, 10));
      }
    }

    const itisToFetch = [...visibleItis].slice(0, 8);
    let changed = false;

    await Promise.all(itisToFetch.map(async (iti) => {
      if (itineraryPointsCache.has(iti)) {
        if (!map.ambientRoutes.has(iti)) {
          map.ambientRoutes.set(iti, { points: itineraryPointsCache.get(iti), color: "#38bdf8" });
          changed = true;
        }
        return;
      }
      try {
        const fallbackUrl = `${SIU_BASE}/V3/buscarItinerario/${iti}/0/POA/retornoJSONItinerario`;
        const data = await smartFetch(fallbackUrl, true);
        const pts = data.route || data.itinerarios || [];
        if (pts.length > 0) {
          const formatted = pts.map((p) => ({
            lat: parseFloat(p.coordY),
            lng: parseFloat(p.coordX)
          }));
          itineraryPointsCache.set(iti, formatted);
          map.ambientRoutes.set(iti, { points: formatted, color: "#38bdf8" });
          changed = true;
        }
      } catch (e) {}
    }));

    if (changed && map) {
      map.renderSvg();
    }
  }

  async function fetchBusesForIti(codIti) {
    codIti = parseInt(codIti, 10);
    if (!codIti) return;
    try {
      const vUrl = `${SIU_BASE}/V3/retornaVeiculosMapa/${codIti}/0/POA/retornoJSONVeiculos`;
      const vRes = await smartFetch(vUrl, true);
      const list = (vRes.veiculos || []).map((v) => enrichVehicleWithHeading({ ...v, codIti }, codIti));
      routeVehiclesMap.set(codIti, list);
      recordVehiclesInPersistentStore(list);
      mergeAndRenderVehicles();
      updateRouteStopsWithEtas();
      logMsg(`Frota da linha ${codIti}: ${list.length} veículos carregados.`);
    } catch (e) {
      logMsg(`Erro fetchBusesForIti (${codIti}): ${e.message}`);
    }
  }

  function mergeAndRenderVehicles() {
    let combined = [];

    const favs = getFavorites();
    const favCodes = new Set((favs.lines || []).map((l) => String(l.code || "").toUpperCase()));
    const favItis = new Set((favs.lines || []).map((l) => String(l.codIti || "")));

    const tagVehicle = (v) => {
      const code = String(v.descricao || v.sgLin || v.lineCode || "").toUpperCase();
      const isFavLine = favCodes.has(code) || favItis.has(String(v.codIti));
      const isTracked = activeRoutes.has(v.codIti) || activeRoutes.has(parseInt(v.codIti, 10));
      v.isSaved = isFavLine || Boolean(v.isSaved);
      v._isTracked = isTracked || Boolean(v._isTracked);
      return v;
    };

    // Sincroniza seleção de ônibus e linha com o mapa para destaque/dimming imediato
    if (map) {
      const selId = currentSelectedBus && currentSelectedBus.veic 
        ? (currentSelectedBus.veic.numVeicGestor || currentSelectedBus.veic.veic || null)
        : null;
      const selLine = currentSelectedBus ? currentSelectedBus.lineCode : null;
      map.selectedBusId = selId;
      map.selectedLineCode = selLine;
    }

    const seen = new Set();

    // 1. Ônibus das linhas ativamente traçadas pelo usuário
    for (const [iti, vList] of routeVehiclesMap.entries()) {
      if (activeRoutes.has(iti)) {
        for (const v of vList) {
          const id = v.numVeicGestor || `${v.lat}_${v.long}`;
          if (!seen.has(id)) {
            seen.add(id);
            combined.push(tagVehicle(v));
          }
        }
      }
    }

    // 2. Ônibus mantidos na memória persistente (nunca desaparecem enquanto estiverem operando)
    if (activeRoutes.size < 2) {
      for (const v of persistentVehicleStore.values()) {
        const id = v.numVeicGestor || `${v.lat}_${v.long}`;
        if (!seen.has(id)) {
          seen.add(id);
          combined.push(tagVehicle(v));
        }
      }
    }

    renderVehicles(combined);
    if (map && map.showFleetCorridors && map.getZoom() >= 15) {
      updateAmbientCorridors(combined);
    }
  }

  async function fetchBusesAround(lat, lng) {
    try {
      const stopsUrl = `${SIU_BASE}/V3/buscarParadasProximas/${lng}/${lat}/0/POA/retornoJSONH`;
      const stopsData = await smartFetch(stopsUrl, true);
      const stops = (stopsData.paradas || []).slice(0, 7);

      const activeItis = new Set();
      const fcPromises = stops.map(async (st) => {
        try {
          const fcUrl = `${SIU_BASE}/V3/buscarPrevisoes/${st.cod}/false/0/POA/retornoJSON`;
          const fcRes = await smartFetch(fcUrl, true);
          (fcRes.previsoes || []).forEach((p) => {
            if (p.codItinerario) activeItis.add(p.codItinerario);
          });
        } catch (e) {}
      });
      await Promise.all(fcPromises);

      const allVeics = [];
      const seenVeics = new Set();
      const vPromises = [...activeItis].slice(0, 12).map(async (iti) => {
        try {
          const vUrl = `${SIU_BASE}/V3/retornaVeiculosMapa/${iti}/0/POA/retornoJSONVeiculos`;
          const vRes = await smartFetch(vUrl, true);
          (vRes.veiculos || []).forEach((v) => {
            const vid = v.numVeicGestor || `${v.lat}_${v.long}`;
            if (!seenVeics.has(vid)) {
              seenVeics.add(vid);
              allVeics.push(enrichVehicleWithHeading({ ...v, codIti: iti }, iti));
            }
          });
        } catch (e) {}
      });
      await Promise.all(vPromises);

      lastBusesAroundList = allVeics;
      recordVehiclesInPersistentStore(allVeics);
      mergeAndRenderVehicles();
    } catch (err) {
      logMsg("Erro fetchBusesAround: " + err.message);
    }
  }

  const expandedLineItis = new Set();
  let lastCombinedVehicles = [];

  function renderTabBusFleet(combinedVehicles = lastCombinedVehicles) {
    if (combinedVehicles && combinedVehicles.length > 0) {
      lastCombinedVehicles = combinedVehicles;
    }
    const trackedListEl = document.getElementById("tracked-lines-list");
    const nearbyListEl = document.getElementById("nearby-buses-list");

    // 1. Linhas com Traçado Ativo no Mapa (Com expansão e drill-down em cada veículo)
    if (trackedListEl) {
      if (activeRoutes.size === 0) {
        trackedListEl.innerHTML = `
          <div class="empty-state" style="padding:10px;">
            <p style="font-size:0.75rem;">Nenhuma linha traçada no momento.<br>Toque em <b>+ Traçar</b> em qualquer linha para desenhar sua rota no mapa.</p>
          </div>
        `;
      } else {
        trackedListEl.innerHTML = "";
        activeRoutes.forEach((r) => {
          const style = ROUTE_STYLES[r.styleIndex] || ROUTE_STYLES[0];
          const veics = routeVehiclesMap.get(r.codIti) || [];
          const isExpanded = expandedLineItis.has(r.codIti);

          const card = document.createElement("div");
          card.className = "tracked-line-card";
          card.style.borderLeft = `4px solid ${style.color}`;

          let vehiclesRowsHtml = "";
          if (isExpanded) {
            if (veics.length === 0) {
              vehiclesRowsHtml = `
                <div class="tracked-line-vehicles-list">
                  <div style="font-size:0.72rem;color:#94a3b8;padding:6px 0;">Buscando ônibus com GPS ativo desta linha...</div>
                </div>
              `;
            } else {
              vehiclesRowsHtml = `
                <div class="tracked-line-vehicles-list">
                  <div style="font-size:0.68rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin:2px 0 4px 0;">
                    Ônibus em Circulação nesta Linha (${veics.length}):
                  </div>
                  ${veics
                    .map((v) => {
                      const vNum = v.numVeicGestor || v.veiculo || v.prefixo || "GPS";
                      const spd = v.velocidade ? `${v.velocidade} km/h` : "GPS Ativo";
                      return `
                      <div class="tracked-vehicle-row" data-veic-num="${vNum}" data-iti="${r.codIti}">
                        <div style="display:flex;align-items:center;gap:6px;">
                          <span style="font-size:1rem;">🚌</span>
                          <div>
                            <span style="font-weight:700;font-size:0.8rem;color:#fff;">Veículo ${vNum}</span>
                            <div style="font-size:0.68rem;color:#94a3b8;">${spd}</div>
                          </div>
                        </div>
                        <button class="btn-small" style="font-size:0.7rem;padding:3px 8px;background:#2563eb;color:#fff;">
                          🔍 Ver Detalhes
                        </button>
                      </div>
                    `;
                    })
                    .join("")}
                </div>
              `;
            }
          }

          card.innerHTML = `
            <div class="tracked-line-header">
              <div style="flex:1;">
                <div style="display:flex;align-items:center;gap:6px;">
                  <span class="bus-badge" style="background:${style.color};color:#fff;font-size:0.75rem;">${r.lineCode}</span>
                  <span style="font-weight:700;font-size:0.82rem;color:#fff;">${r.lineName || `Itinerário ${r.codIti}`}</span>
                </div>
                <div style="font-size:0.7rem;color:#94a3b8;margin-top:3px;">
                  🚌 <b>${veics.length}</b> ônibus em tempo real • <span style="color:${style.color};">${style.name} (${style.label})</span>
                </div>
              </div>
              <div style="display:flex;gap:6px;align-items:center;">
                <span style="font-size:0.75rem;color:#94a3b8;margin-right:2px;">${isExpanded ? "▲" : "▼"}</span>
                <button class="btn-trace active" style="font-size:0.72rem;padding:4px 8px;" onclick="event.stopPropagation(); window.toggleRoute(${r.codIti}, '${r.lineCode}', '${(r.lineName || "").replace(/'/g, "\\'")}')">
                  ✕ Remover
                </button>
              </div>
            </div>
            ${vehiclesRowsHtml}
          `;

          // Clique no header expande/recolhe a linha
          card.querySelector(".tracked-line-header").onclick = (e) => {
            if (e.target.closest(".btn-trace")) return;
            if (expandedLineItis.has(r.codIti)) {
              expandedLineItis.delete(r.codIti);
            } else {
              expandedLineItis.add(r.codIti);
              if (map && r.points && r.points.length > 0) {
                map.fitBounds(r.points);
                showToast(`Focado na linha ${r.lineCode}`);
              }
            }
            renderTabBusFleet();
          };

          // Clique em um veículo específico da linha
          card.querySelectorAll(".tracked-vehicle-row").forEach((row) => {
            row.onclick = (e) => {
              e.stopPropagation();
              const vNum = row.getAttribute("data-veic-num");
              const targetV = veics.find((v) => (v.numVeicGestor || v.veiculo || v.prefixo || "GPS") == vNum);
              if (targetV) {
                selectBus(targetV, r.codIti);
                if (map && targetV.lat && targetV.long) {
                  map.setView(parseFloat(targetV.lat), parseFloat(targetV.long), 16);
                }
                const bdc = document.getElementById("bus-details-content");
                if (bdc) {
                  bdc.style.display = "block";
                  bdc.scrollIntoView({ behavior: "smooth" });
                }
              }
            };
          });

          trackedListEl.appendChild(card);
        });
      }
    }

    // 2. Ônibus em Circulação ao Redor
    if (nearbyListEl) {
      if (activeRoutes.size >= 2) {
        nearbyListEl.innerHTML = `
          <div class="empty-state" style="padding:10px;">
            <p style="font-size:0.75rem;">Foco exclusivo ativado: exibindo apenas a frota das <b>${activeRoutes.size} linhas traçadas</b>.</p>
          </div>
        `;
      } else if (!combinedVehicles || combinedVehicles.length === 0) {
        nearbyListEl.innerHTML = `
          <div class="empty-state" style="padding:10px;">
            <p style="font-size:0.75rem;">Nenhum ônibus em circulação direta no momento.</p>
          </div>
        `;
      } else {
        nearbyListEl.innerHTML = "";
        combinedVehicles.slice(0, 20).forEach((v) => {
          const codItiNum = parseInt(v.codIti, 10);
          const isTracked = codItiNum && activeRoutes.has(codItiNum);
          const lineCode = v.sgLin || (v.descricao || "").split("-")[0].trim() || "Linha";
          const lineDesc = v.descricao || v.apelidoLinha || `Veículo ${v.numVeicGestor || v.veiculo || "GPS"}`;
          const vNum = v.numVeicGestor || v.veiculo || v.prefixo || "GPS";

          const card = document.createElement("div");
          card.className = "fav-card";
          card.innerHTML = `
            <div class="fav-card-left" style="flex:1;cursor:pointer;">
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="bus-badge" style="font-size:0.72rem;">${lineCode}</span>
                <span style="font-weight:700;font-size:0.8rem;color:#fff;">${lineDesc}</span>
              </div>
              <div style="font-size:0.68rem;color:#94a3b8;margin-top:2px;">
                Veículo: <b>${vNum}</b> ${isTracked ? '• <span style="color:#10b981;font-weight:bold;">Traçado no Mapa</span>' : ""}
              </div>
            </div>
            <div>
              ${
                codItiNum
                  ? `<button class="btn-trace ${isTracked ? "active" : ""}" style="font-size:0.72rem;padding:4px 8px;" onclick="window.toggleRoute(${codItiNum}, '${lineCode}', '${lineDesc.replace(/'/g, "\\'")}')">
                      ${isTracked ? "✕ Remover" : "+ Traçar"}
                     </button>`
                  : ""
              }
            </div>
          `;
          card.querySelector(".fav-card-left").onclick = () => {
            selectBus(v, v.codIti);
            if (map && v.lat && v.long) {
              map.setView(parseFloat(v.lat), parseFloat(v.long), 16);
            }
          };
          nearbyListEl.appendChild(card);
        });
      }
    }
  }

  function renderVehicles(vehiclesListOrMap) {
    let veicArray = [];
    if (Array.isArray(vehiclesListOrMap)) {
      veicArray = vehiclesListOrMap;
    } else if (vehiclesListOrMap && typeof vehiclesListOrMap === "object") {
      Object.keys(vehiclesListOrMap).forEach((iti) => {
        const list = vehiclesListOrMap[iti] || [];
        list.forEach((v) => veicArray.push({ ...v, codIti: iti }));
      });
    }

    if (map) {
      map.setVehicles(veicArray, (v, codIti) => selectBus(v, codIti));
    }

    renderTabBusFleet(veicArray);

    if (activeBusesCount) {
      if (activeRoutes.size >= 2) {
        activeBusesCount.innerHTML = `🚌 <b>${veicArray.length} ônibus</b> (${activeRoutes.size} linhas traçadas)`;
        activeBusesCount.style.borderColor = "#38bdf8";
      } else if (veicArray.length > 0) {
        const isSim = veicArray[0]._simulatedStops ? " (Simulação)" : "";
        activeBusesCount.innerHTML = `🚌 <b>${veicArray.length} ônibus</b> ao redor${isSim}`;
        activeBusesCount.style.borderColor = "#10b981";
      } else {
        const hr = new Date().getHours();
        if (hr >= 23 || hr < 5) {
          activeBusesCount.innerHTML = `🌙 Frota em recolhimento (Noturno) <button id="btn-night-sim" style="background:#2563eb;color:#fff;border:none;border-radius:10px;padding:2px 8px;font-size:0.68rem;cursor:pointer;margin-left:4px;font-weight:700;">Simular</button>`;
          const btnNightSim = document.getElementById("btn-night-sim");
          if (btnNightSim) {
            btnNightSim.onclick = (e) => {
              e.stopPropagation();
              toggleSimulation(true);
            };
          }
        } else {
          activeBusesCount.innerHTML = `🚌 0 ônibus ao redor`;
        }
      }
    }
  }

  // --- TAB 2: Stop Selection ---
  async function selectStop(stop, isDest) {
    currentSelectedStop = stop;
    switchTab("tab-stop");

    if (stopDetailsEmpty) stopDetailsEmpty.style.display = "none";
    if (stopDetailsContent) stopDetailsContent.style.display = "block";

    if (stopTitle) stopTitle.textContent = stop.desc ? stop.desc.split("-")[0].trim() : `Parada ${stop.cod}`;
    const walkText = stop.distance_to_dest_m ? `${stop.distance_to_dest_m}m a pé de casa` : "";
    if (stopCode) {
      const stopLat = stop.y !== undefined ? stop.y : stop.lat || 0;
      const stopLng = stop.x !== undefined ? stop.x : stop.lng || 0;
      const stopDescSafe = (stop.desc || stop.descricao || `Parada ${stop.cod}`).replace(/'/g, "\\'");
      stopCode.innerHTML = `
        Código: <b>${stop.cod}</b> ${walkText ? "• " + walkText : ""}
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button class="btn-primary" style="flex:1;padding:6px 4px;font-size:0.75rem;background:#2563eb;" onclick="window.setStopAsOrigin(${stop.cod}, ${stopLat}, ${stopLng}, '${stopDescSafe}')">📍 Usar como Origem</button>
          <button class="btn-primary" style="flex:1;padding:6px 4px;font-size:0.75rem;background:#10b981;" onclick="window.setStopAsDest(${stop.cod}, ${stopLat}, ${stopLng}, '${stopDescSafe}')">🏁 Usar como Destino</button>
        </div>
      `;
    }

    updateFavStopButton();

    if (stopForecastsList) stopForecastsList.innerHTML = `<div class="empty-state"><p>Carregando ônibus desta parada...</p></div>`;
    if (stopLinesWrap) stopLinesWrap.innerHTML = `<div class="empty-state"><p>Carregando linhas...</p></div>`;

    try {
      const fallbackLines = `${SIU_BASE}/retornaLinhasQueAtendemParada/${stop.cod}/0/retornoJSON`;
      const fallbackPrev = `${SIU_BASE}/V3/buscarPrevisoes/${stop.cod}/false/0/POA/retornoJSON`;

      const [lData, fData] = await Promise.all([
        smartFetch(fallbackLines, true),
        smartFetch(fallbackPrev, true)
      ]);
      const lines = lData.linhas || [];
      const forecasts = fData.previsoes || [];

      // Forecasts
      if (forecasts.length === 0) {
        if (stopForecastsList) {
          stopForecastsList.innerHTML = `
            <div class="eta-night-notice">
              🌙 <b>Nenhum ônibus com GPS ativo detectado se aproximando agora</b><br>
              <small>Isto é comum em horários noturnos ou no intervalo entre viagens. Consulte abaixo <b>todas as linhas regulares</b> que atendem esta parada:</small>
            </div>
          `;
        }
      } else {
        if (stopForecastsList) {
          stopForecastsList.innerHTML = "";
          forecasts.forEach((f) => {
            const isTracked = f.codItinerario && activeRoutes.has(parseInt(f.codItinerario, 10));
            const isSoon = f.prev && (f.prev.includes("1 ") || f.prev.includes("2 ") || f.prev.includes("3 ") || f.prev.includes("Minutos"));
            
            // Estimativa de horário no relógio
            let etaClock = "";
            const minMatch = (f.prev || "").match(/(\d+)/);
            if (minMatch) {
              const mins = parseInt(minMatch[1], 10);
              const etaDate = new Date(Date.now() + mins * 60000);
              etaClock = `Chegada prevista às ${etaDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            }

            const div = document.createElement("div");
            div.className = "eta-card-live";
            div.innerHTML = `
              <div class="eta-header-row">
                <span class="eta-badge-live">⏱️ Chega em ${f.prev || "Em trânsito"}</span>
                ${etaClock ? `<span style="font-size:0.72rem;color:var(--text-muted);font-weight:600;">${etaClock}</span>` : ""}
              </div>
              <div style="font-weight:800;font-size:0.92rem;color:#ffffff;margin-top:2px;">
                ${f.sgLin || "LINHA"} - ${f.apelidoLinha || ""}
              </div>
              <div style="font-size:0.72rem;color:var(--text-muted);margin:4px 0 8px 0;">
                Veículo: <b style="color:var(--accent-light);">${f.numVeicGestor || "GPS Ao Vivo"}</b> • Parada <b>${stop.cod}</b>
              </div>
              <div>
                ${
                  f.codItinerario
                    ? `<button class="btn-trace ${isTracked ? "active" : ""}" data-trace-iti="${f.codItinerario}" onclick="window.toggleRoute(${f.codItinerario}, '${f.sgLin || ""}', '${f.apelidoLinha || ""}')">
                        ${isTracked ? "✕ Remover Traçado" : "+ Traçar Rota no Mapa"}
                       </button>`
                    : ""
                }
              </div>
            `;
            stopForecastsList.appendChild(div);
          });
        }
      }

      // Lines
      if (lines.length === 0) {
        if (stopLinesWrap) stopLinesWrap.innerHTML = `<div style="font-size:0.75rem;color:var(--text-muted)">Nenhuma linha registrada.</div>`;
      } else {
        if (stopLinesWrap) {
          stopLinesWrap.innerHTML = "";
          lines.forEach((l) => {
            const num = l.num_linha || l.cod_linha;
            const div = document.createElement("div");
            div.className = "line-badge-item";
            div.title = l.descricao;
            div.innerHTML = `
              <span class="line-badge-code">${num}</span>
              <span class="line-badge-name">${l.descricao}</span>
            `;
            stopLinesWrap.appendChild(div);
          });
        }
      }
    } catch (e) {
      if (stopForecastsList) stopForecastsList.innerHTML = `<div style="color:var(--danger)">Erro ao carregar dados.</div>`;
    }
  }

  if (btnFavStop) {
    btnFavStop.addEventListener("click", () => {
      if (currentSelectedStop) toggleFavoriteStop(currentSelectedStop);
    });
  }

  // --- TAB 3: Bus Selection & Upcoming Stops Timeline with ETA ---
  async function selectBus(veic, codIti) {
    codIti = parseInt(codIti, 10);
    enrichVehicleWithHeading(veic, codIti);

    currentSelectedBus = {
      veic,
      codIti,
      lineCode: veic.descricao || `Linha ${codIti}`
    };

    if (map) {
      map.setSelection(veic.numVeicGestor || veic.veic, veic.descricao || `Linha ${codIti}`);
    }

    // Auto-trace da rota deste ônibus no mapa (sem alterar zoom)
    if (codIti && !activeRoutes.has(codIti)) {
      // Se houver rota do sentido oposto traçada para a mesma linha, remove para exibir o traçado real deste ônibus
      const compIti = getCompanionItinerary(codIti, veic.descricao);
      if (compIti && activeRoutes.has(compIti)) {
        removeRoute(compIti, true);
      }
      window.toggleRoute(
        codIti,
        (veic.descricao || `Linha ${codIti}`).replace(/'/g, ""),
        `Ônibus ${veic.numVeicGestor || ""}`,
        true // fromBusClick = true
      );
    } else if (codIti && activeRoutes.has(codIti)) {
      // Ajusta ou inverte o sentido conforme a direção deste ônibus específico
      const route = activeRoutes.get(codIti);
      const vLat = parseFloat(veic.lat);
      const vLng = parseFloat(veic.long !== undefined ? veic.long : veic.lng);
      if (route && route.points && !isNaN(vLat) && !isNaN(vLng)) {
        const routeBearing = getRouteHeadingForBus(vLat, vLng, route.points);
        const busHeading = (veic.heading !== null && veic.heading !== undefined) ? veic.heading : null;
        if (routeBearing !== null && busHeading !== null) {
          let diff = Math.abs(busHeading - routeBearing);
          if (diff > 180) diff = 360 - diff;
          const isOpposite = diff > 90;
          if (route.reverseFlow !== isOpposite) {
            route.reverseFlow = isOpposite;
            if (map) map.renderSvg();
            updateActiveRoutesTray();
            updateRouteStopsWithEtas();
            showToast(`Sentido ajustado pelo Ônibus ${veic.numVeicGestor || ""}: ${isOpposite ? "Bairro ➔ Centro" : "Centro ➔ Bairro"}`);
          }
        }
      }
    }

    switchTab("tab-bus");
    expandPanel();

    if (busDetailsEmpty) busDetailsEmpty.style.display = "none";
    if (busDetailsContent) busDetailsContent.style.display = "block";

    let speedBadge = "Em trânsito";
    if (veic.vel) {
      const vVal = Math.round(parseFloat(veic.vel));
      if (vVal >= 35) speedBadge = `⚡ <span style="color:#10b981;font-weight:700;">${vVal} km/h (Fluindo)</span>`;
      else if (vVal >= 15) speedBadge = `⚡ <span style="color:#f59e0b;font-weight:700;">${vVal} km/h (Moderado)</span>`;
      else speedBadge = `⚡ <span style="color:#ef4444;font-weight:700;">${vVal} km/h (Lento)</span>`;
    }
    if (busCardTitle) busCardTitle.textContent = `Ônibus ${veic.numVeicGestor || veic.veic || "Prefixo"}`;
    if (busCardDesc) busCardDesc.innerHTML = `${veic.descricao || `Linha ${codIti}`} • ${speedBadge}`;

    updateFavLineButton();

    if (btnAlarmBus) {
      const busId = veic.numVeicGestor || veic.veic || "";
      const isAlarmed = activeBusAlarm && activeBusAlarm.busId === busId;
      btnAlarmBus.classList.toggle("active", isAlarmed);
      btnAlarmBus.textContent = isAlarmed ? "🔕 Alarme Ligado" : "🔔 Avisar";
    }

    const isTracked = activeRoutes.has(codIti);
    if (busTraceBtnSlot) {
      busTraceBtnSlot.innerHTML = `
        <button class="btn-trace ${isTracked ? "active" : ""}" data-trace-iti="${codIti}" onclick="window.toggleRoute(${codIti}, '${(veic.descricao || "").replace(/'/g, "")}', 'Ônibus ${veic.numVeicGestor || ""}', true)">
          ${isTracked ? "✕ Ocultar Traçado no Mapa" : "+ Traçar Linha Completa no Mapa"}
        </button>
      `;
    }

    if (busStopsTimeline) {
      busStopsTimeline.innerHTML = `
        <div style="padding:14px;text-align:center;color:var(--accent-light);">
          <div class="spinning" style="display:inline-block;margin-bottom:6px;">🔄</div>
          <div>Calculando itinerário e previsão de chegada nas paradas...</div>
        </div>
      `;
    }

    try {
      let stops = [];
      if (veic._simulatedStops) {
        stops = veic._simulatedStops;
      } else {
        const fallbackUrl = `${SIU_BASE}/buscarParadasPorItiComCoordenadas/${codIti}/0/retornoJSONPontosItinerario`;
        const data = await smartFetch(fallbackUrl, true);
        stops = data.paradas || [];
      }

      if (!stops || stops.length === 0) {
        if (busStopsTimeline) {
          busStopsTimeline.innerHTML = `<div class="empty-state"><p>Nenhuma parada cadastrada para esta linha.</p></div>`;
        }
        return;
      }

      const bLat = parseFloat(veic.lat);
      const bLng = parseFloat(veic.long);

      // Localizar a parada mais próxima da posição atual do ônibus
      let closestIdx = 0;
      let minDist = Infinity;
      stops.forEach((s, idx) => {
        const d = calcDistanceMeters(bLat, bLng, s.y, s.x);
        if (d < minDist) {
          minDist = d;
          closestIdx = idx;
        }
      });

      const upcomingStops = stops.slice(closestIdx);
      if (upcomingStops.length === 0) {
        if (busStopsTimeline) {
          busStopsTimeline.innerHTML = `<div class="empty-state"><p>Ônibus chegando ao ponto final da linha.</p></div>`;
        }
        return;
      }

      let timelineHtml = `<div class="timeline-stops-container">`;
      let cumDistMeters = minDist;

      upcomingStops.slice(0, 20).forEach((s, idx) => {
        if (idx > 0) {
          const prevStop = upcomingStops[idx - 1];
          cumDistMeters += calcDistanceMeters(prevStop.y, prevStop.x, s.y, s.x);
        }

        // Estimativa precisa: Proximidade física direta nas primeiras paradas
        let etaMins = 1;
        if (cumDistMeters <= 250) {
          etaMins = 1;
        } else if (cumDistMeters <= 550) {
          etaMins = 2;
        } else if (cumDistMeters <= 950) {
          etaMins = 3;
        } else if (cumDistMeters <= 1400) {
          etaMins = 4;
        } else {
          // Estimativa de velocidade média urbana (~350 m/min = 21 km/h) + 40s por parada
          etaMins = Math.max(1, Math.round(cumDistMeters / 350 + idx * 0.65));
        }
        const etaDate = new Date(Date.now() + etaMins * 60000);
        const etaTimeStr = etaDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const distStr = cumDistMeters >= 1000 ? `${(cumDistMeters / 1000).toFixed(1)} km` : `${Math.round(cumDistMeters)}m`;
        const isNext = idx === 0;

        if (isNext && activeBusAlarm && !activeBusAlarm.triggered && activeBusAlarm.busId === (veic.numVeicGestor || veic.veic)) {
          if (etaMins <= 3) {
            activeBusAlarm.triggered = true;
            playProximityChime();
            showToast(`🔔 ALARME: Ônibus ${activeBusAlarm.busId} se aproximando! Chegada em ~${etaMins} min!`);
          }
        }

        timelineHtml += `
          <div class="timeline-stop-row ${isNext ? "is-next" : ""}" onclick="window.centerOnStop(${s.y}, ${s.x}, '${(s.desc || "").replace(/'/g, "")}')">
            <div class="timeline-stop-dot"></div>
            <div class="timeline-stop-info">
              <div class="timeline-stop-name">${s.desc ? s.desc.split("-")[0].trim() : `Parada ${s.cod}`}</div>
              <div class="timeline-stop-meta">
                <span class="timeline-stop-eta-pill ${etaMins <= 3 ? "near" : ""}">
                  ⏱️ ${etaMins} min (${distStr}) • Chegada ~${etaTimeStr}
                </span>
                <span style="color:var(--text-muted)">Cód: ${s.cod}</span>
              </div>
            </div>
          </div>
        `;
      });

      if (upcomingStops.length > 20) {
        timelineHtml += `
          <div style="font-size:0.72rem;color:var(--accent-light);padding:8px 0 0 28px;">
            + mais ${upcomingStops.length - 20} paradas até o término da linha.
          </div>
        `;
      }
      timelineHtml += `</div>`;

      if (busStopsTimeline) busStopsTimeline.innerHTML = timelineHtml;
    } catch (e) {
      logMsg("Erro ao processar próximas paradas: " + e.message);
      if (busStopsTimeline) {
        busStopsTimeline.innerHTML = `<div class="empty-state"><p>Erro ao carregar próximas paradas da linha.</p></div>`;
      }
    }
  }

  window.centerOnStop = function(lat, lng, name) {
    if (map) {
      map.setView(lat, lng, 16);
      showToast(`🚏 ${name}`);
    }
  };

  if (btnFavLine) {
    btnFavLine.addEventListener("click", () => {
      if (currentSelectedBus) {
        toggleFavoriteLine(currentSelectedBus.lineCode, currentSelectedBus.lineCode, currentSelectedBus.codIti);
      }
    });
  }

  // --- Bottom Sheet & Tabs Switching ---
  function expandPanel() {
    if (!mainPanel || window.innerWidth >= 768) return;
    const maxHeight = Math.round(window.innerHeight * 0.50);
    mainPanel.style.height = `${maxHeight}px`;
    mainPanel.classList.remove("minimized");
    const hText = document.getElementById("panel-handle-text");
    if (hText) hText.innerHTML = `<span class="handle-icon">▼</span> <span class="handle-label">Recolher Aba</span>`;
    setTimeout(() => {
      if (map) map.resize();
    }, 260);
  }

  function collapsePanel() {
    if (!mainPanel || window.innerWidth >= 768) return;
    mainPanel.style.height = "48px";
    mainPanel.classList.add("minimized");
    const hText = document.getElementById("panel-handle-text");
    if (hText) hText.innerHTML = `<span class="handle-icon">▲</span> <span class="handle-label">Expandir Linhas</span>`;
    setTimeout(() => {
      if (map) map.resize();
    }, 260);
  }

  function togglePanel() {
    if (!mainPanel || window.innerWidth >= 768) return;
    if (mainPanel.offsetHeight <= 70 || mainPanel.classList.contains("minimized")) {
      expandPanel();
    } else {
      collapsePanel();
    }
  }

  function switchTab(tabId) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));

    const btn = document.querySelector(`[data-tab="${tabId}"]`);
    const content = document.getElementById(tabId);
    if (btn) btn.classList.add("active");
    if (content) content.classList.add("active");

    if (tabId === "tab-favs") {
      renderFavoritesTab();
    }

    expandPanel();
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
    });
  });

  // --- Multi-Route Overlay (Até 5 linhas simultâneas) ---
  const CANOAS_CENTER_LAT = -29.9189;
  const CANOAS_CENTER_LNG = -51.1804;
  let pendingRoutePrompt = null;

  // Mapa de Pares de Itinerários (Ida e Volta / Centro-Bairro e Bairro-Centro com ruas reais)
  const CANOAS_LINE_PAIRS = {
    "5103": [2442, 2432], // 2442: Centro ➔ Bairro | 2432: Bairro ➔ Centro
    "05103": [2442, 2432],
    "5106": [2476, 2486], // 2476: Centro ➔ Bairro | 2486: Bairro ➔ Centro
    "05106": [2476, 2486],
    "5000": [2478, 2457],
    "05000": [2478, 2457],
    "5001": [2471, 2473],
    "05001": [2471, 2473],
    "5104": [2998, 3050],
    "05104": [2998, 3050],
    "5110": [3040, 2470],
    "05110": [3040, 2470],
    "5112": [2469, 3149],
    "05112": [2469, 3149],
    "5131": [2966, 3138],
    "05131": [2966, 3138],
    "5200": [2485, 2433],
    "05200": [2485, 2433],
    "5201": [2453, 2482],
    "05201": [2453, 2482],
    "5222": [3166, 3121],
    "05222": [3166, 3121],
    "8100": [100, 99],
    "8200": [170, 171]
  };

  const ITI_COMPANION_MAP = new Map();
  for (const pair of Object.values(CANOAS_LINE_PAIRS)) {
    if (pair && pair.length >= 2) {
      ITI_COMPANION_MAP.set(pair[0], pair[1]);
      ITI_COMPANION_MAP.set(pair[1], pair[0]);
    }
  }

  function getCompanionItinerary(codIti, lineCode = null) {
    codIti = parseInt(codIti, 10);
    if (ITI_COMPANION_MAP.has(codIti)) return ITI_COMPANION_MAP.get(codIti);
    if (lineCode) {
      const cleanCode = String(lineCode).replace(/^0+/, "").trim();
      const pair = CANOAS_LINE_PAIRS[cleanCode] || CANOAS_LINE_PAIRS["0" + cleanCode];
      if (pair) {
        if (pair[0] === codIti) return pair[1];
        if (pair[1] === codIti) return pair[0];
        return pair[1];
      }
    }
    return null;
  }

  window.promptRouteDirection = function (codIti, lineCode, lineName) {
    const modal = document.getElementById("route-direction-modal");
    const titleEl = document.getElementById("route-direction-title");
    if (!modal) {
      executeToggleRoute(codIti, lineCode, lineName, "centro_to_bairro", false);
      return;
    }
    pendingRoutePrompt = { codIti, lineCode, lineName };
    if (titleEl) {
      titleEl.textContent = `Linha ${lineCode}${lineName ? " - " + lineName : ""}`;
    }
    modal.style.display = "flex";
  };

  const btnDirForward = document.getElementById("btn-dir-forward");
  const btnDirReverse = document.getElementById("btn-dir-reverse");
  const btnCloseRouteDir = document.getElementById("btn-close-route-direction");
  const routeDirModal = document.getElementById("route-direction-modal");

  if (btnDirForward) {
    btnDirForward.onclick = () => {
      if (routeDirModal) routeDirModal.style.display = "none";
      if (pendingRoutePrompt) {
        let { codIti, lineCode, lineName } = pendingRoutePrompt;
        pendingRoutePrompt = null;
        const cleanCode = String(lineCode).replace(/^0+/, "").trim();
        const pair = CANOAS_LINE_PAIRS[cleanCode] || CANOAS_LINE_PAIRS["0" + cleanCode];
        if (pair && pair[0]) codIti = pair[0];
        executeToggleRoute(codIti, lineCode, lineName, "centro_to_bairro", false);
      }
    };
  }

  if (btnDirReverse) {
    btnDirReverse.onclick = () => {
      if (routeDirModal) routeDirModal.style.display = "none";
      if (pendingRoutePrompt) {
        let { codIti, lineCode, lineName } = pendingRoutePrompt;
        pendingRoutePrompt = null;
        const cleanCode = String(lineCode).replace(/^0+/, "").trim();
        const pair = CANOAS_LINE_PAIRS[cleanCode] || CANOAS_LINE_PAIRS["0" + cleanCode];
        if (pair && pair[1]) codIti = pair[1];
        executeToggleRoute(codIti, lineCode, lineName, "bairro_to_centro", false);
      }
    };
  }

  if (btnCloseRouteDir) {
    btnCloseRouteDir.onclick = () => {
      if (routeDirModal) routeDirModal.style.display = "none";
      pendingRoutePrompt = null;
    };
  }

  if (routeDirModal) {
    routeDirModal.onclick = (e) => {
      if (e.target === routeDirModal) {
        routeDirModal.style.display = "none";
        pendingRoutePrompt = null;
      }
    };
  }

  window.reverseRouteFlow = async function (codIti) {
    codIti = parseInt(codIti, 10);
    const r = activeRoutes.get(codIti);
    if (!r) return;

    const compIti = getCompanionItinerary(codIti, r.lineCode);
    if (compIti && compIti !== codIti) {
      // Alterna para o traçado do sentido oposto real (ruas reais de volta)
      const curBus = currentSelectedBus;
      removeRoute(codIti, true);
      await executeToggleRoute(compIti, r.lineCode, r.lineName, "companion", false);
      if (curBus) {
        currentSelectedBus = curBus; // Preserva o ônibus selecionado
        if (map && curBus.veic) {
          map.setSelection(curBus.veic.numVeicGestor || curBus.veic.veic, curBus.lineCode);
        }
      }
      const newR = activeRoutes.get(compIti);
      const newDir = newR ? newR.directionLabel : "sentido oposto";
      showToast(`⇄ Traçado alternado: ${newDir}`);
      return;
    }

    // Fallback se não houver itinerário de volta registrado
    r.reverseFlow = !r.reverseFlow;
    if (map) map.renderSvg();
    updateActiveRoutesTray();
    updateRouteStopsWithEtas();
    showToast(`⇄ Sentido invertido: ${r.reverseFlow ? "Volta" : "Ida"}`);
  };

  window.toggleRoute = async function (codIti, lineCode, lineName, fromBusClick = false, forcedReverse = undefined) {
    codIti = parseInt(codIti, 10);
    if (!codIti) return;

    if (activeRoutes.has(codIti)) {
      removeRoute(codIti);
      return;
    }

    if (activeRoutes.size >= 5) {
      showToast("⚠️ Limite de 5 traçados atingido! Remova um para adicionar outro.");
      return;
    }

    if (!fromBusClick && forcedReverse === undefined) {
      window.promptRouteDirection(codIti, lineCode, lineName);
      return;
    }

    await executeToggleRoute(codIti, lineCode, lineName, forcedReverse !== undefined ? forcedReverse : false, fromBusClick);
  };

  async function executeToggleRoute(codIti, lineCode, lineName, targetDirection = "centro_to_bairro", fromBusClick = false) {
    codIti = parseInt(codIti, 10);
    if (!codIti) return;

    const usedStyleIndices = new Set([...activeRoutes.values()].map((r) => r.styleIndex));
    let styleIndex = 0;
    for (let i = 0; i < ROUTE_STYLES.length; i++) {
      if (!usedStyleIndices.has(i)) {
        styleIndex = i;
        break;
      }
    }

    const style = ROUTE_STYLES[styleIndex];
    showToast(`Carregando traçado da Linha ${lineCode} (${style.name})...`);

    try {
      const fallbackUrl = `${SIU_BASE}/V3/buscarItinerario/${codIti}/0/POA/retornoJSONItinerario`;
      const data = await smartFetch(fallbackUrl, true);
      const points = data.route || data.itinerarios || [];

      if (points.length === 0) {
        showToast("⚠️ Traçado não disponível.");
        return;
      }

      const formattedPoints = points.map((p) => ({
        lat: parseFloat(p.coordY),
        lng: parseFloat(p.coordX)
      }));

      // Determina geografia dos terminais (Centro vs Bairro)
      const pStart = formattedPoints[0];
      const pEnd = formattedPoints[formattedPoints.length - 1];
      const dStartCentro = Math.hypot(pStart.lat - CANOAS_CENTER_LAT, pStart.lng - CANOAS_CENTER_LNG);
      const dEndCentro = Math.hypot(pEnd.lat - CANOAS_CENTER_LAT, pEnd.lng - CANOAS_CENTER_LNG);
      const startIsCentro = dStartCentro < dEndCentro;
      const directionLabel = startIsCentro ? "Centro ➔ Bairro" : "Bairro ➔ Centro";

      let reverseFlow = false;
      if (fromBusClick && currentSelectedBus && currentSelectedBus.veic) {
        const v = currentSelectedBus.veic;
        const vLat = parseFloat(v.lat);
        const vLng = parseFloat(v.long !== undefined ? v.long : v.lng);
        const routeBearing = getRouteHeadingForBus(vLat, vLng, formattedPoints);
        const busHeading = (v.heading !== null && v.heading !== undefined) ? v.heading : null;
        if (routeBearing !== null && busHeading !== null) {
          let diff = Math.abs(busHeading - routeBearing);
          if (diff > 180) diff = 360 - diff;
          reverseFlow = diff > 90;
        }
      }

      // Busca paradas deste itinerário para exibir ao dar zoom
      let routeStops = [];
      try {
        const stopsUrl = `${SIU_BASE}/buscarParadasPorItiComCoordenadas/${codIti}/0/retornoJSONPontosItinerario`;
        const stopsData = await smartFetch(stopsUrl, true);
        routeStops = stopsData.paradas || [];
      } catch (err) {}

      activeRoutes.set(codIti, {
        codIti,
        lineCode: lineCode || "Linha",
        lineName: lineName || "",
        styleIndex,
        color: style.color,
        dash: style.dash,
        points: formattedPoints,
        stops: routeStops,
        reverseFlow,
        directionLabel
      });

      if (map) {
        map.setRoutes(activeRoutes);
        // Mantém zoom e posição do usuário intactos sem abrir zoom
      }

      fetchBusesForIti(codIti);
      mergeAndRenderVehicles();
      updateRouteStopsWithEtas();
      updateActiveRoutesTray();
      refreshAllTraceButtons(codIti, true);
      showToast(`✓ Linha ${lineCode} adicionada (${directionLabel})!`);
    } catch (e) {
      showToast("Erro ao obter traçado.");
    }
  }

  function removeRoute(codIti, preserveSelection = false) {
    codIti = parseInt(codIti, 10);
    if (!activeRoutes.has(codIti)) return;
    const r = activeRoutes.get(codIti);
    activeRoutes.delete(codIti);
    routeVehiclesMap.delete(codIti);

    if (!preserveSelection && (activeRoutes.size === 0 || (currentSelectedBus && currentSelectedBus.codIti === codIti))) {
      currentSelectedBus = null;
      if (map) {
        map.selectedBusId = null;
        map.selectedLineCode = null;
      }
      if (busDetailsContent) busDetailsContent.style.display = "none";
      if (busDetailsEmpty && activeRoutes.size === 0) busDetailsEmpty.style.display = "block";
    }

    if (map) map.setRoutes(activeRoutes);
    mergeAndRenderVehicles();
    updateRouteStopsWithEtas();
    updateActiveRoutesTray();
    refreshAllTraceButtons(codIti, false);
    if (!preserveSelection) showToast(`Linha ${r.lineCode} removida.`);
  }

  function refreshAllTraceButtons(codIti, isTracked) {
    document.querySelectorAll(`[data-trace-iti="${codIti}"]`).forEach((btn) => {
      btn.classList.toggle("active", isTracked);
      btn.textContent = isTracked
        ? btn.textContent.includes("Rota")
          ? "✕ Remover Traçado"
          : "✕ Remover"
        : btn.textContent.includes("Rota")
        ? "+ Traçar Rota Deste Ônibus"
        : "+ Traçar";
    });
    renderFavoritesTab();
  }

  const btnToggleCorridors = document.getElementById("btn-toggle-corridors");
  if (btnToggleCorridors) {
    btnToggleCorridors.addEventListener("click", () => {
      const isActive = btnToggleCorridors.classList.toggle("active");
      if (map) {
        map.setShowFleetCorridors(isActive);
        if (isActive) {
          if (map.getZoom() < 15) {
            showToast("🛣️ Traçados ativados! Dê mais zoom para ver as rotas nas ruas.");
          } else {
            showToast("🛣️ Traçados discretos dos ônibus na tela ativados!");
          }
          updateAmbientCorridors();
        } else {
          showToast("🛣️ Traçados em tela desativados.");
        }
      }
    });
  }

  if (btnClearAllRoutes) {
    btnClearAllRoutes.addEventListener("click", () => {
      activeRoutes.clear();
      routeVehiclesMap.clear();
      currentSelectedBus = null;
      if (map) {
        map.selectedBusId = null;
        map.selectedLineCode = null;
        map.setRoutes(activeRoutes);
      }
      mergeAndRenderVehicles();
      updateRouteStopsWithEtas();
      updateActiveRoutesTray();
      if (busDetailsContent) busDetailsContent.style.display = "none";
      if (busDetailsEmpty) busDetailsEmpty.style.display = "block";
      document.querySelectorAll(".btn-trace").forEach((btn) => {
        btn.classList.remove("active");
        btn.textContent = btn.textContent.includes("Rota") ? "+ Traçar Rota Deste Ônibus" : "+ Traçar";
      });
      renderFavoritesTab();
      showToast("Todos os traçados e destaques foram limpos.");
    });
  }

  function updateActiveRoutesTray() {
    if (!activeRoutesChips || !activeRoutesTray) return;
    activeRoutesChips.innerHTML = "";

    if (activeRoutes.size === 0) {
      activeRoutesTray.classList.remove("visible");
      return;
    }

    activeRoutesTray.classList.add("visible");

    activeRoutes.forEach((r) => {
      const style = ROUTE_STYLES[r.styleIndex];
      const badge = document.createElement("div");
      badge.className = "route-pill-badge";
      badge.style.backgroundColor = style.color;
      const dirText = r.directionLabel || (r.reverseFlow ? "Bairro ➔ Centro" : "Centro ➔ Bairro");
      badge.innerHTML = `
        <span class="route-pill-dir" title="Toque para alternar para o traçado do sentido oposto">⇄ ${dirText}</span>
        <span>${style.dash ? "╌" : "●"} ${r.lineCode}</span>
        <span class="route-pill-remove" title="Remover">✕</span>
      `;

      badge.querySelector(".route-pill-dir").onclick = (e) => {
        e.stopPropagation();
        window.reverseRouteFlow(r.codIti);
      };

      badge.querySelector(".route-pill-remove").onclick = (e) => {
        e.stopPropagation();
        removeRoute(r.codIti);
      };

      badge.onclick = () => {
        expandPanel();
      };

      activeRoutesChips.appendChild(badge);
    });
  }

  if (activeRoutesTray) {
    activeRoutesTray.addEventListener("click", (e) => {
      if (!e.target.closest(".route-pill-remove") && !e.target.closest(".btn-clear-routes")) {
        expandPanel();
      }
    });
  }

  // --- Draggable Bottom Sheet for Mobile (Minimized 48px <-> Half-Screen 50vh Max) ---
  function setupDraggablePanel() {
    if (!panelDragHandle || !mainPanel) return;

    let startY = 0;
    let startHeight = 0;
    let isDragging = false;
    let hasDraggedPanel = false;

    panelDragHandle.addEventListener(
      "touchstart",
      (e) => {
        if (window.innerWidth >= 768) return;
        isDragging = true;
        hasDraggedPanel = false;
        startY = e.touches[0].clientY;
        startHeight = mainPanel.offsetHeight;
        mainPanel.classList.add("dragging");
      },
      { passive: true }
    );

    window.addEventListener(
      "touchmove",
      (e) => {
        if (!isDragging || window.innerWidth >= 768) return;
        const deltaY = e.touches[0].clientY - startY;
        if (Math.abs(deltaY) > 5) hasDraggedPanel = true;

        const maxHeight = Math.round(window.innerHeight * 0.50); // Máximo metade da tela
        const minHeight = 48; // Minimizável a 48px
        let newHeight = startHeight - deltaY;

        if (newHeight < minHeight) newHeight = minHeight;
        if (newHeight > maxHeight) newHeight = maxHeight;

        mainPanel.style.height = `${newHeight}px`;
      },
      { passive: true }
    );

    window.addEventListener("touchend", () => {
      if (!isDragging || window.innerWidth >= 768) return;
      isDragging = false;
      mainPanel.classList.remove("dragging");

      if (hasDraggedPanel) {
        const currentHeight = mainPanel.offsetHeight;
        const snapMin = 48;
        const snapHalf = Math.round(window.innerHeight * 0.50);

        if (currentHeight < (snapMin + snapHalf) / 2) {
          collapsePanel();
        } else {
          expandPanel();
        }
      }
    });

    panelDragHandle.addEventListener("click", (e) => {
      if (hasDraggedPanel) {
        hasDraggedPanel = false;
        return;
      }
      togglePanel();
    });

    const tabsBar = document.querySelector(".tabs");
    if (tabsBar) {
      tabsBar.addEventListener("click", () => {
        if (mainPanel.offsetHeight <= 70) {
          expandPanel();
        }
      });
    }

    const rowOrigin = document.getElementById("row-origin");
    if (rowOrigin) {
      rowOrigin.addEventListener("click", (e) => {
        if (e.target.id !== "btn-edit-origin") expandPanel();
      });
    }

    const rowDest = document.getElementById("row-dest");
    if (rowDest) {
      rowDest.addEventListener("click", (e) => {
        if (e.target.id !== "btn-edit-dest") expandPanel();
      });
    }
  }

  // --- TRENSURB RAILWAY TRACKING & PREDICTIONS (Linha 1: POA ⇄ Canoas ⇄ NH) ---
  const TRENSURB_STATIONS = [
    { id: 1, name: "Mercado", short: "MERC", city: "Porto Alegre", lat: -30.0278, lng: -51.2289, vip: true },
    { id: 2, name: "Rodoviária", short: "RODO", city: "Porto Alegre", lat: -30.0242, lng: -51.2186, vip: false },
    { id: 3, name: "São Pedro", short: "SPED", city: "Porto Alegre", lat: -30.0075, lng: -51.2092, vip: false },
    { id: 4, name: "Farrapos", short: "FARR", city: "Porto Alegre", lat: -29.9961, lng: -51.1978, vip: false },
    { id: 5, name: "Aeroporto", short: "AERO", city: "Porto Alegre", lat: -29.9886, lng: -51.1897, vip: false },
    { id: 6, name: "Anchieta", short: "ANCH", city: "Porto Alegre", lat: -29.9744, lng: -51.1844, vip: false },
    { id: 7, name: "Niterói", short: "NITE", city: "Canoas", lat: -29.9536, lng: -51.1836, vip: false },
    { id: 8, name: "Fátima", short: "FATI", city: "Canoas", lat: -29.9392, lng: -51.1814, vip: false },
    { id: 9, name: "Canoas", short: "CANO", city: "Canoas", lat: -29.9197, lng: -51.1803, vip: true },
    { id: 10, name: "Mathias Velho", short: "MVEL", city: "Canoas", lat: -29.9042, lng: -51.1800, vip: true },
    { id: 11, name: "São Luís", short: "SLUI", city: "Canoas", lat: -29.8911, lng: -51.1806, vip: true },
    { id: 12, name: "Petrobras", short: "PETR", city: "Canoas/Esteio", lat: -29.8731, lng: -51.1814, vip: false },
    { id: 13, name: "Esteio", short: "ESTE", city: "Esteio", lat: -29.8542, lng: -51.1822, vip: false },
    { id: 14, name: "Luiz Pasteur", short: "LPAZ", city: "Sapucaia", lat: -29.8394, lng: -51.1683, vip: false },
    { id: 15, name: "Sapucaia", short: "SAPU", city: "Sapucaia", lat: -29.8272, lng: -51.1506, vip: false },
    { id: 16, name: "Unisinos", short: "UNIS", city: "São Leopoldo", lat: -29.7958, lng: -51.1500, vip: false },
    { id: 17, name: "São Leopoldo", short: "SLEO", city: "São Leopoldo", lat: -29.7667, lng: -51.1461, vip: false },
    { id: 18, name: "Rio dos Sinos", short: "RSIN", city: "São Leopoldo", lat: -29.7508, lng: -51.1394, vip: false },
    { id: 19, name: "Santo Afonso", short: "SAFO", city: "Novo Hamburgo", lat: -29.7289, lng: -51.1331, vip: false },
    { id: 20, name: "Fenac", short: "FENC", city: "Novo Hamburgo", lat: -29.7042, lng: -51.1344, vip: false },
    { id: 21, name: "Novo Hamburgo", short: "NHAM", city: "Novo Hamburgo", lat: -29.6869, lng: -51.1319, vip: false }
  ];

  let trensurbDistances = [0];
  for (let i = 0; i < TRENSURB_STATIONS.length - 1; i++) {
    const d = calcDistanceMeters(
      TRENSURB_STATIONS[i].lat,
      TRENSURB_STATIONS[i].lng,
      TRENSURB_STATIONS[i + 1].lat,
      TRENSURB_STATIONS[i + 1].lng
    );
    trensurbDistances.push(trensurbDistances[i] + d);
  }
  const trensurbTotalMeters = trensurbDistances[trensurbDistances.length - 1];

  function getTrensurbCoordAtFraction(frac) {
    frac = Math.max(0, Math.min(1, frac));
    const targetMeters = frac * trensurbTotalMeters;
    for (let i = 0; i < TRENSURB_STATIONS.length - 1; i++) {
      if (targetMeters >= trensurbDistances[i] && targetMeters <= trensurbDistances[i + 1]) {
        const segSpan = trensurbDistances[i + 1] - trensurbDistances[i];
        const segFrac = segSpan > 0 ? (targetMeters - trensurbDistances[i]) / segSpan : 0;
        const lat = TRENSURB_STATIONS[i].lat + (TRENSURB_STATIONS[i + 1].lat - TRENSURB_STATIONS[i].lat) * segFrac;
        const lng = TRENSURB_STATIONS[i].lng + (TRENSURB_STATIONS[i + 1].lng - TRENSURB_STATIONS[i].lng) * segFrac;
        return { lat, lng, segIndex: i };
      }
    }
    return {
      lat: TRENSURB_STATIONS[TRENSURB_STATIONS.length - 1].lat,
      lng: TRENSURB_STATIONS[TRENSURB_STATIONS.length - 1].lng,
      segIndex: TRENSURB_STATIONS.length - 2
    };
  }

  const TRENSURB_FLEET_DEFS = [
    { id: "102", offsetMinutes: 0, isNewModel: false, modelLabel: "Série 100 (Clássico)" },
    { id: "204", offsetMinutes: 18, isNewModel: true, modelLabel: "Série 200 (Novo Aerodinâmico)" },
    { id: "108", offsetMinutes: 36, isNewModel: false, modelLabel: "Série 100 (Clássico)" },
    { id: "210", offsetMinutes: 54, isNewModel: true, modelLabel: "Série 200 (Novo Aerodinâmico)" },
    { id: "114", offsetMinutes: 72, isNewModel: false, modelLabel: "Série 100 (Clássico)" },
    { id: "212", offsetMinutes: 90, isNewModel: true, modelLabel: "Série 200 (Novo Aerodinâmico)" }
  ];

  function calculateTrensurbTrains() {
    const roundTripSec = 108 * 60;
    const oneWaySec = 54 * 60;
    const nowSec = Date.now() / 1000;

    return TRENSURB_FLEET_DEFS.map((tDef) => {
      const elapsed = (nowSec + tDef.offsetMinutes * 60) % roundTripSec;
      const isNorth = elapsed < oneWaySec;
      const frac = isNorth ? elapsed / oneWaySec : 1 - (elapsed - oneWaySec) / oneWaySec;
      const direction = isNorth ? "Novo Hamburgo (Norte)" : "Mercado (Sul)";

      const pos = getTrensurbCoordAtFraction(frac);
      const speed = Math.round(48 + 14 * Math.sin(frac * Math.PI * 4));

      const nextStIndex = isNorth
        ? Math.min(pos.segIndex + 1, TRENSURB_STATIONS.length - 1)
        : Math.max(pos.segIndex, 0);
      const nextSt = TRENSURB_STATIONS[nextStIndex];

      const distToNext = calcDistanceMeters(pos.lat, pos.lng, nextSt.lat, nextSt.lng);
      const etaSec = Math.max(30, Math.round(distToNext / ((speed * 1000) / 3600)));
      const etaMin = Math.ceil(etaSec / 60);

      return {
        trainId: tDef.id,
        shortName: tDef.isNewModel ? `S200-${tDef.id}` : `S100-${tDef.id}`,
        direction,
        isNorth,
        isNewModel: tDef.isNewModel,
        modelLabel: tDef.modelLabel,
        frac,
        lat: pos.lat,
        lng: pos.lng,
        speed,
        nextStation: nextSt.name,
        nextStationId: nextSt.id,
        etaMin
      };
    });
  }

  function selectTrensurbStation(st) {
    switchTab("tab-stop");
    expandPanel();

    if (stopDetailsEmpty) stopDetailsEmpty.style.display = "none";
    if (stopDetailsContent) stopDetailsContent.style.display = "block";

    if (stopTitle) stopTitle.innerHTML = `Estação ${st.name} <span style="font-size:0.85rem;color:#38bdf8;">🚈 Trensurb</span>`;
    if (stopCode) {
      stopCode.innerHTML = `
        <span style="color:#38bdf8;font-weight:700;">Linha 1 Metrô Trensurb</span> • ${st.city} ${st.vip ? "• ⭐ Estação Principal" : ""}
      `;
    }

    const trains = calculateTrensurbTrains();
    const arrivalsMercado = [];
    const arrivalsNH = [];

    trains.forEach((tr) => {
      if (tr.isNorth && st.id >= tr.nextStationId) {
        const distM = trensurbDistances[st.id - 1] - tr.frac * trensurbTotalMeters;
        const mins = Math.max(1, Math.round(distM / ((tr.speed * 1000) / 3600) / 60));
        arrivalsNH.push({ train: tr, mins, distKm: (distM / 1000).toFixed(1) });
      } else if (!tr.isNorth && st.id <= tr.nextStationId) {
        const distM = tr.frac * trensurbTotalMeters - trensurbDistances[st.id - 1];
        const mins = Math.max(1, Math.round(distM / ((tr.speed * 1000) / 3600) / 60));
        arrivalsMercado.push({ train: tr, mins, distKm: (distM / 1000).toFixed(1) });
      }
    });

    arrivalsMercado.sort((a, b) => a.mins - b.mins);
    arrivalsNH.sort((a, b) => a.mins - b.mins);

    if (stopForecastsList) {
      let html = `<div style="font-weight:700;font-size:0.85rem;color:#38bdf8;margin-bottom:8px;">🚆 Previsões de Chegada em Tempo Real</div>`;

      // Sentido Mercado (POA - Sul) - AZUL
      html += `<div style="font-weight:700;font-size:0.78rem;color:#38bdf8;margin:6px 0;">↓ Sentido Mercado (Sul / Porto Alegre) — AZUL:</div>`;
      if (arrivalsMercado.length > 0) {
        arrivalsMercado.slice(0, 2).forEach((arr) => {
          const etaDate = new Date(Date.now() + arr.mins * 60000);
          const clock = etaDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const iconEmoji = arr.train.isNewModel ? "🚆" : "🚈";
          const glassBadge = arr.train.isNewModel
            ? `<span class="train-glass-tag glass-yellow" style="position:static;display:inline-block;padding:1px 6px;margin-left:4px;">❄️ AR NOVO</span>`
            : `<span class="train-glass-tag glass-white" style="position:static;display:inline-block;padding:1px 6px;margin-left:4px;">💨 S100</span>`;
          html += `
            <div class="eta-card-live" style="border-left: 4px solid #0284c7;background:rgba(2,132,199,0.12);margin-bottom:6px;">
              <div class="eta-header-row">
                <span class="eta-badge-live" style="background:#0284c7;">⏱️ Em ${arr.mins} min (${clock})</span>
                <span style="font-size:0.7rem;color:#94a3b8;">${arr.distKm} km • ${arr.train.speed} km/h</span>
              </div>
              <div style="font-weight:800;color:#fff;margin-top:3px;display:flex;align-items:center;gap:4px;">
                ${iconEmoji} Trem ${arr.train.trainId} — <span style="color:#38bdf8;">${arr.train.modelLabel}</span> ${glassBadge}
              </div>
            </div>
          `;
        });
      } else {
        html += `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">Nenhum trem nesta direção nos próximos minutos.</div>`;
      }

      // Sentido Novo Hamburgo (Norte) - VERMELHO
      html += `<div style="font-weight:700;font-size:0.78rem;color:#ef4444;margin:10px 0 6px 0;">↑ Sentido Novo Hamburgo (Norte) — VERMELHO:</div>`;
      if (arrivalsNH.length > 0) {
        arrivalsNH.slice(0, 2).forEach((arr) => {
          const etaDate = new Date(Date.now() + arr.mins * 60000);
          const clock = etaDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const iconEmoji = arr.train.isNewModel ? "🚆" : "🚈";
          const glassBadge = arr.train.isNewModel
            ? `<span class="train-glass-tag glass-yellow" style="position:static;display:inline-block;padding:1px 6px;margin-left:4px;">❄️ AR NOVO</span>`
            : `<span class="train-glass-tag glass-white" style="position:static;display:inline-block;padding:1px 6px;margin-left:4px;">💨 S100</span>`;
          html += `
            <div class="eta-card-live" style="border-left: 4px solid #dc2626;background:rgba(220,38,38,0.12);margin-bottom:6px;">
              <div class="eta-header-row">
                <span class="eta-badge-live" style="background:#dc2626;">⏱️ Em ${arr.mins} min (${clock})</span>
                <span style="font-size:0.7rem;color:#94a3b8;">${arr.distKm} km • ${arr.train.speed} km/h</span>
              </div>
              <div style="font-weight:800;color:#fff;margin-top:3px;display:flex;align-items:center;gap:4px;">
                ${iconEmoji} Trem ${arr.train.trainId} — <span style="color:#f87171;">${arr.train.modelLabel}</span> ${glassBadge}
              </div>
            </div>
          `;
        });
      } else {
        html += `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">Nenhum trem nesta direção nos próximos minutos.</div>`;
      }

      stopForecastsList.innerHTML = html;
    }

    if (stopLinesWrap) {
      stopLinesWrap.innerHTML = `
        <div style="font-size:0.75rem;color:#cbd5e1;line-height:1.4;">
          <b>Linha 1 Trensurb:</b> 22 Estações operando diariamente das 05h às 23h20.<br>
          Intervalo médio de 10 a 12 minutos nos horários de pico.
        </div>
      `;
    }
  }

  function selectTrain(tr) {
    switchTab("tab-bus");
    expandPanel();

    if (busDetailsEmpty) busDetailsEmpty.style.display = "none";
    if (busDetailsContent) busDetailsContent.style.display = "block";

    const dirColor = tr.isNorth ? "#ef4444" : "#38bdf8";
    const dirBg = tr.isNorth ? "#dc2626" : "#0284c7";
    const dirArrow = tr.isNorth ? "↑" : "↓";
    const iconEmoji = tr.isNewModel ? "🚆" : "🚈";

    if (busCardTitle) {
      const glassBadge = tr.isNewModel
        ? `<span class="train-glass-tag glass-yellow" style="position:static;display:inline-block;padding:2px 7px;font-size:0.75rem;font-weight:700;">❄️ AR NOVO</span>`
        : `<span class="train-glass-tag glass-white" style="position:static;display:inline-block;padding:2px 7px;font-size:0.75rem;font-weight:700;">💨 S100</span>`;
      busCardTitle.innerHTML = `${iconEmoji} Trem ${tr.trainId} ${glassBadge} <span style="font-size:0.75rem;background:${dirBg};color:#fff;padding:2px 8px;border-radius:10px;font-weight:700;">${tr.modelLabel}</span>`;
    }
    if (busCardDesc) {
      const windowType = tr.isNewModel
        ? `<b style="color:#f59e0b;">Vidros Amarelos Térmicos (Ar Condicionado)</b>`
        : `<b style="color:#cbd5e1;">Vidros Brancos Tradicionais (Ventilação)</b>`;
      busCardDesc.innerHTML = `Sentido <b style="color:${dirColor};">${dirArrow} ${tr.direction}</b> • Velocidade: <span style="color:#10b981;font-weight:700;">${tr.speed} km/h</span><br><span style="font-size:0.72rem;">${windowType}</span>`;
    }

    if (busTraceBtnSlot) {
      busTraceBtnSlot.innerHTML = `
        <button class="btn-primary" style="background:${dirBg};width:100%;padding:8px;font-size:0.8rem;border-radius:8px;" onclick="window.focusTrensurbTrack()">
          ${iconEmoji} Acompanhar Linha no Mapa
        </button>
      `;
    }

    if (busStopsTimeline) {
      let html = `<div style="font-weight:700;font-size:0.82rem;color:#38bdf8;margin-bottom:8px;">Próximas Estações deste Trem:</div>`;

      const upcomingStations = [];
      if (tr.isNorth) {
        for (let i = tr.nextStationId - 1; i < TRENSURB_STATIONS.length; i++) {
          const st = TRENSURB_STATIONS[i];
          const distM = trensurbDistances[st.id - 1] - tr.frac * trensurbTotalMeters;
          const mins = Math.max(1, Math.round(distM / ((tr.speed * 1000) / 3600) / 60));
          upcomingStations.push({ st, mins });
        }
      } else {
        for (let i = tr.nextStationId - 1; i >= 0; i--) {
          const st = TRENSURB_STATIONS[i];
          const distM = tr.frac * trensurbTotalMeters - trensurbDistances[st.id - 1];
          const mins = Math.max(1, Math.round(distM / ((tr.speed * 1000) / 3600) / 60));
          upcomingStations.push({ st, mins });
        }
      }

      if (upcomingStations.length === 0) {
        html += `<div style="font-size:0.75rem;color:var(--text-muted)">Trem próximo ao terminal de linha.</div>`;
      } else {
        upcomingStations.slice(0, 8).forEach((item, idx) => {
          const etaDate = new Date(Date.now() + item.mins * 60000);
          const clock = etaDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const isNext = idx === 0;
          html += `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:${isNext ? "rgba(2,132,199,0.18)" : "rgba(30,41,59,0.6)"};border:1px solid ${isNext ? "#0284c7" : "#334155"};border-radius:8px;margin-bottom:5px;">
              <div>
                <span style="font-weight:700;font-size:0.82rem;color:#fff;">${item.st.vip ? "⭐" : "🚈"} Estação ${item.st.name}</span>
                <div style="font-size:0.68rem;color:#94a3b8;">${item.st.city}</div>
              </div>
              <div style="text-align:right;">
                <span style="font-weight:800;font-size:0.82rem;color:${isNext ? "#38bdf8" : "#e2e8f0"};">${item.mins} min</span>
                <div style="font-size:0.68rem;color:#94a3b8;">${clock}</div>
              </div>
            </div>
          `;
        });
      }

      busStopsTimeline.innerHTML = html;
    }
  }

  let showTrensurb = localStorage.getItem("busradar_show_trensurb") === "true";
  let trensurbInterval = null;

  window.isTrensurbEnabled = function () {
    return showTrensurb;
  };

  window.setTrensurbEnabled = function (enabled) {
    showTrensurb = Boolean(enabled);
    localStorage.setItem("busradar_show_trensurb", showTrensurb ? "true" : "false");
    initTrensurb();
    renderTripMatchesList();
    if (map) {
      if (!showTrensurb) {
        map.setTrainTrack([]);
        map.setTrainStations([]);
        map.setTrains([]);
      }
    }
  };

  function initTrensurb() {
    if (!map) return;
    if (!showTrensurb) {
      if (trensurbInterval) {
        clearInterval(trensurbInterval);
        trensurbInterval = null;
      }
      if (typeof map.setTrainTrack === "function") map.setTrainTrack([]);
      if (typeof map.setTrainStations === "function") map.setTrainStations([]);
      if (typeof map.setTrains === "function") map.setTrains([]);
      return;
    }

    // 1. Plot railway track
    const trackCoords = TRENSURB_STATIONS.map((s) => ({ lat: s.lat, lng: s.lng }));
    if (typeof map.setTrainTrack === "function") {
      map.setTrainTrack(trackCoords);
    }

    // 2. Set stations
    map.setTrainStations(TRENSURB_STATIONS, (st) => selectTrensurbStation(st));

    // 3. Update train positions continuously
    function updateTrains() {
      if (!showTrensurb) return;
      const activeTrains = calculateTrensurbTrains();
      map.setTrains(activeTrains, (tr) => selectTrain(tr));
    }

    updateTrains();
    if (trensurbInterval) clearInterval(trensurbInterval);
    trensurbInterval = setInterval(updateTrains, 3000);
    logMsg("Trensurb: Linha 1 e trens em circulação inicializados com sucesso.");
  }

  window.focusTrensurbTrack = function () {
    if (map) {
      map.setView(-29.9197, -51.1803, 13);
      showToast("🚈 Linha 1 Trensurb (Mercado ⇄ Canoas ⇄ NH)");
    }
  };

  // --- TRANSIT SIMULATION / DEMO MODE (Para testar ônibus em movimento a qualquer hora) ---
  let isSimulationActive = false;
  let simulationInterval = null;
  const simulatedBuses = [
    {
      numVeicGestor: "5102",
      descricao: "5102 - CENTRO / GUAJUVIRAS",
      codIti: "5102",
      vel: 34,
      routePoints: [
        { lat: -29.9195, lng: -51.1812 },
        { lat: -29.9168, lng: -51.1760 },
        { lat: -29.9142, lng: -51.1695 },
        { lat: -29.9105, lng: -51.1620 },
        { lat: -29.9070, lng: -51.1550 },
        { lat: -29.9040, lng: -51.1470 }
      ],
      currentIdx: 0,
      direction: 1,
      _simulatedStops: [
        { cod: "101", desc: "Terminal Centro - Victor Barreto", y: -29.9195, x: -51.1812 },
        { cod: "102", desc: "Av. Victor Barreto - Estação Mathias", y: -29.9168, x: -51.1760 },
        { cod: "103", desc: "Av. Getúlio Vargas - Praça do Avião", y: -29.9142, x: -51.1695 },
        { cod: "104", desc: "Av. Santos Ferreira - Hospital", y: -29.9105, x: -51.1620 },
        { cod: "105", desc: "Av. Santos Ferreira - Supermercado", y: -29.9070, x: -51.1550 },
        { cod: "106", desc: "Terminal Guajuviras", y: -29.9040, x: -51.1470 }
      ]
    },
    {
      numVeicGestor: "5201",
      descricao: "5201 - FÁTIMA / CENTRO",
      codIti: "5201",
      vel: 28,
      routePoints: [
        { lat: -29.9320, lng: -51.1920 },
        { lat: -29.9280, lng: -51.1880 },
        { lat: -29.9230, lng: -51.1840 },
        { lat: -29.9190, lng: -51.1804 },
        { lat: -29.9150, lng: -51.1770 }
      ],
      currentIdx: 0,
      direction: 1,
      _simulatedStops: [
        { cod: "201", desc: "Terminal Bairro Fátima", y: -29.9320, x: -51.1920 },
        { cod: "202", desc: "Rua Bartolomeu de Gusmão", y: -29.9280, x: -51.1880 },
        { cod: "203", desc: "Av. Guilherme Schell - Estação Fátima", y: -29.9230, x: -51.1840 },
        { cod: "204", desc: "Centro de Canoas - Estação Canoas", y: -29.9190, x: -51.1804 },
        { cod: "205", desc: "Av. Victor Barreto - La Salle", y: -29.9150, x: -51.1770 }
      ]
    },
    {
      numVeicGestor: "5300",
      descricao: "5300 - MATHIAS VELHO / HARMONIA",
      codIti: "5300",
      vel: 31,
      routePoints: [
        { lat: -29.9080, lng: -51.1950 },
        { lat: -29.9120, lng: -51.1900 },
        { lat: -29.9160, lng: -51.1850 },
        { lat: -29.9190, lng: -51.1804 },
        { lat: -29.9220, lng: -51.1750 }
      ],
      currentIdx: 2,
      direction: 1,
      _simulatedStops: [
        { cod: "301", desc: "Av. Rio Grande do Sul - Harmonia", y: -29.9080, x: -51.1950 },
        { cod: "302", desc: "Rua Florianópolis - Mathias Velho", y: -29.9120, x: -51.1900 },
        { cod: "303", desc: "Av. Guilherme Schell - Viaduto", y: -29.9160, x: -51.1850 },
        { cod: "304", desc: "Centro - Galeria Comercial", y: -29.9190, x: -51.1804 },
        { cod: "305", desc: "Av. Getúlio Vargas - Carrefour", y: -29.9220, x: -51.1750 }
      ]
    },
    {
      numVeicGestor: "5404",
      descricao: "5404 - BOQUEIRÃO / IGARA",
      codIti: "5404",
      vel: 38,
      routePoints: [
        { lat: -29.9190, lng: -51.1804 },
        { lat: -29.9150, lng: -51.1680 },
        { lat: -29.9100, lng: -51.1590 },
        { lat: -29.9050, lng: -51.1500 },
        { lat: -29.8990, lng: -51.1410 }
      ],
      currentIdx: 1,
      direction: 1,
      _simulatedStops: [
        { cod: "401", desc: "Estação Canoas - Centro", y: -29.9190, x: -51.1804 },
        { cod: "402", desc: "Av. Boqueirão - ParkShopping", y: -29.9150, x: -51.1680 },
        { cod: "403", desc: "Av. Boqueirão - Ulbra", y: -29.9100, x: -51.1590 },
        { cod: "404", desc: "Av. Açucena - Igara", y: -29.9050, x: -51.1500 },
        { cod: "405", desc: "Terminal Boqueirão", y: -29.8990, x: -51.1410 }
      ]
    }
  ];

  function toggleSimulation(forceState) {
    isSimulationActive = typeof forceState === "boolean" ? forceState : !isSimulationActive;
    const btnDevDemo = document.getElementById("dev-btn-toggle-demo");

    if (isSimulationActive) {
      if (btnDevDemo) btnDevDemo.textContent = "Parar Simulação";
      showToast("🚌 Modo Simulação Ativado! 4 ônibus em movimento.");
      logMsg("Simulação de ônibus em tempo real ATIVADA.");
      if (simulationInterval) clearInterval(simulationInterval);
      simulationInterval = setInterval(stepSimulation, 2400);
      stepSimulation();
    } else {
      if (btnDevDemo) btnDevDemo.textContent = "Simular Ônibus";
      showToast("Modo Simulação desativado.");
      logMsg("Simulação de ônibus DESATIVADA.");
      if (simulationInterval) clearInterval(simulationInterval);
      simulationInterval = null;
      if (map) {
        const c = map.getCenter();
        fetchBusesAround(c.lat, c.lng);
      }
    }
  }

  function stepSimulation() {
    if (!isSimulationActive) return;
    const activeList = [];

    simulatedBuses.forEach((b) => {
      b.currentIdx += b.direction;
      if (b.currentIdx >= b.routePoints.length - 1) {
        b.direction = -1;
      } else if (b.currentIdx <= 0) {
        b.direction = 1;
      }

      const pt = b.routePoints[b.currentIdx];
      const jitterLat = (Math.random() - 0.5) * 0.0003;
      const jitterLng = (Math.random() - 0.5) * 0.0003;
      const lat = (pt.lat + jitterLat).toFixed(6);
      const long = (pt.lng + jitterLng).toFixed(6);

      activeList.push(
        enrichVehicleWithHeading(
          {
            numVeicGestor: b.numVeicGestor,
            veic: b.numVeicGestor,
            descricao: b.descricao,
            codIti: b.codIti,
            lat,
            long,
            vel: Math.round(b.vel + (Math.random() - 0.5) * 6),
            _simulatedStops: b._simulatedStops
          },
          b.codIti
        )
      );
    });

    renderVehicles(activeList);

    if (currentSelectedBus && currentSelectedBus.veic) {
      const match = activeList.find((v) => v.numVeicGestor === currentSelectedBus.veic.numVeicGestor);
      if (match) {
        currentSelectedBus.veic = match;
        if (busCardDesc) {
          busCardDesc.textContent = `${match.descricao} • ⚡ ${match.vel} km/h (Simulado)`;
        }
      }
    }
  }

  // --- DEVELOPER MODE & SOBRE O APP (1 Toque: Sobre/API/Logs | 5 Toques: Modo Dev) ---
  const appLogoArea = document.getElementById("app-logo-area");
  const devTelemetryBar = document.getElementById("dev-telemetry-bar");
  const devGpsInfo = document.getElementById("dev-gps-info");
  const devNetInfo = document.getElementById("dev-net-info");
  const devTilesInfo = document.getElementById("dev-tiles-info");
  const devBtnSwitchTile = document.getElementById("dev-btn-switch-tile");
  const devBtnConfigTile = document.getElementById("dev-btn-config-tile");
  const devBtnToggleDemo = document.getElementById("dev-btn-toggle-demo");
  const devBtnCopyLog = document.getElementById("dev-btn-copy-log");
  const devBtnCloseDev = document.getElementById("dev-btn-close-dev");

  let appLogoTapCount = 0;
  let appLogoTapTimer = null;
  let appLogoSingleTapTimer = null;
  let isDevModeActive = localStorage.getItem("busradar_dev_mode") === "1";

  if (isDevModeActive && devTelemetryBar) {
    devTelemetryBar.style.display = "flex";
  }

  function setDevMode(active) {
    isDevModeActive = active;
    try {
      localStorage.setItem("busradar_dev_mode", active ? "1" : "0");
    } catch (e) {}
    if (devTelemetryBar) {
      devTelemetryBar.style.display = active ? "flex" : "none";
    }
    showToast(active ? "🚀 Modo Desenvolvedor ATIVADO!" : "Modo Desenvolvedor desativado.");
    logMsg("Modo Desenvolvedor " + (active ? "Ativado" : "Desativado"));
  }

  if (appLogoArea) {
    appLogoArea.addEventListener("click", () => {
      appLogoTapCount++;
      clearTimeout(appLogoTapTimer);
      clearTimeout(appLogoSingleTapTimer);

      appLogoTapTimer = setTimeout(() => {
        appLogoTapCount = 0;
      }, 1600);

      if (appLogoTapCount >= 5) {
        appLogoTapCount = 0;
        clearTimeout(appLogoSingleTapTimer);
        setDevMode(!isDevModeActive);
      } else if (appLogoTapCount === 1) {
        // 1 clique: abre o Sobre / Informações (com botões de Mapa/API, Logs, Casa e Modo Dev)
        appLogoSingleTapTimer = setTimeout(() => {
          if (appLogoTapCount === 1) {
            appLogoTapCount = 0;
            if (aboutModal) aboutModal.style.display = "flex";
          }
        }, 320);
      } else if (appLogoTapCount === 3 || appLogoTapCount === 4) {
        showToast(`Faltam ${5 - appLogoTapCount} toques para o Modo Desenvolvedor...`);
      }
    });
  }

  if (devBtnCloseDev) {
    devBtnCloseDev.addEventListener("click", () => {
      setDevMode(false);
    });
  }

  // Developer Mode Telemetry Update Loop
  setInterval(() => {
    if (!isDevModeActive || !devTelemetryBar) return;
    if (devGpsInfo) {
      devGpsInfo.textContent = userCoords
        ? `GPS: ${userCoords.lat.toFixed(4)}, ${userCoords.lng.toFixed(4)}`
        : "GPS: Aguardando...";
    }
    if (devNetInfo) {
      devNetInfo.textContent = window.AndroidBridge ? "REDE: Nativo (Java Worker)" : "REDE: Web (Fetch/JSONP)";
    }
    if (devTilesInfo && map) {
      devTilesInfo.textContent = `TILES: ${map.getTileTierName()} (Z${map.getZoom()})`;
    }
  }, 1000);

  // Switch Tile Provider in Developer Mode (Ciclagem por todos os 7 Tiers)
  if (devBtnSwitchTile) {
    devBtnSwitchTile.addEventListener("click", () => {
      if (map) {
        const nextTier = (map.tileTier % 7) + 1;
        map.setTileTier(nextTier);
        if (devTilesInfo) devTilesInfo.textContent = `TILES: ${map.getTileTierName()} (Z${map.getZoom()})`;
        showToast(`✓ Mapa fixado: ${map.getTileTierName()}`);
      }
    });
  }

  // Toggle Transit Simulation in Developer Mode
  if (devBtnToggleDemo) {
    devBtnToggleDemo.addEventListener("click", () => {
      toggleSimulation();
    });
  }

  // Copy Full Log in Developer Mode
  if (devBtnCopyLog) {
    devBtnCopyLog.addEventListener("click", () => {
      const allText = (window.appLogs || []).join("\n");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(allText).then(() => {
          showToast("📋 Log copiado para a Área de Transferência!");
        });
      } else {
        const ta = document.createElement("textarea");
        ta.value = allText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast("📋 Log copiado!");
      }
    });
  }

  // --- CONFIGURAÇÕES (TRENSURB) MODAL ---
  const tileConfigModal = document.getElementById("tile-config-modal");
  const btnCloseTileConfig = document.getElementById("btn-close-tile-config");
  const btnCancelTileConfig = document.getElementById("btn-cancel-tile-config");
  const btnSaveTileConfig = document.getElementById("btn-save-tile-config");

  function openTileConfigModal() {
    if (!tileConfigModal) return;
    const chkShowTrensurb = document.getElementById("chk-show-trensurb");
    if (chkShowTrensurb) {
      chkShowTrensurb.checked = showTrensurb;
    }
    tileConfigModal.style.display = "flex";
  }

  function closeTileConfigModal() {
    if (tileConfigModal) tileConfigModal.style.display = "none";
  }

  if (devBtnConfigTile) {
    devBtnConfigTile.addEventListener("click", openTileConfigModal);
  }
  if (btnCloseTileConfig) {
    btnCloseTileConfig.addEventListener("click", closeTileConfigModal);
  }
  if (btnCancelTileConfig) {
    btnCancelTileConfig.addEventListener("click", closeTileConfigModal);
  }

  if (btnSaveTileConfig) {
    btnSaveTileConfig.addEventListener("click", () => {
      const chkShowTrensurb = document.getElementById("chk-show-trensurb");
      if (chkShowTrensurb) {
        setTrensurbEnabled(chkShowTrensurb.checked);
        showToast(`✓ Configuração salva: Trensurb ${chkShowTrensurb.checked ? "Ativado" : "Desativado"}`);
      }
      closeTileConfigModal();
    });
  }

  // --- PROXIMITY ALARM & AUDIO CHIME (Avisa quando o ônibus estiver chegando) ---
  let activeBusAlarm = null;

  function playProximityChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
      }
    } catch (e) {}

    if (navigator.vibrate) {
      try {
        navigator.vibrate([200, 100, 200, 100, 350]);
      } catch (e) {}
    }
  }

  const btnAlarmBus = document.getElementById("btn-alarm-bus");
  if (btnAlarmBus) {
    btnAlarmBus.addEventListener("click", () => {
      if (!currentSelectedBus || !currentSelectedBus.veic) {
        showToast("Selecione um ônibus primeiro.");
        return;
      }
      const busId = currentSelectedBus.veic.numVeicGestor || currentSelectedBus.veic.veic || "selecionado";
      if (activeBusAlarm && activeBusAlarm.busId === busId) {
        activeBusAlarm = null;
        btnAlarmBus.classList.remove("active");
        btnAlarmBus.textContent = "🔔 Avisar";
        showToast("Alarme de proximidade desativado.");
      } else {
        activeBusAlarm = {
          busId,
          codIti: currentSelectedBus.codIti,
          triggered: false
        };
        btnAlarmBus.classList.add("active");
        btnAlarmBus.textContent = "🔕 Alarme Ligado";
        playProximityChime();
        showToast(`🔔 Alarme Ativado! Você será avisado quando o ônibus ${busId} estiver a 3 min.`);
      }
    });
  }

  // --- ABOUT MODAL (Sobre o App) ---
  const btnAbout = document.getElementById("btn-about");
  const aboutModal = document.getElementById("about-modal");
  const btnCloseAbout = document.getElementById("btn-close-about");
  const btnModalOk = document.getElementById("btn-modal-ok");
  const btnHeaderDownload = document.getElementById("btn-header-download");

  if (btnHeaderDownload && !window.AndroidBridge) {
    btnHeaderDownload.style.display = "flex";
  }

  // Deploy silencioso via ADB (disponível apenas no PC em localhost)
  const adbPushCard = document.getElementById("adb-push-card");
  const btnAdbInstall = document.getElementById("btn-adb-install");
  const btnAdbConnect = document.getElementById("btn-adb-connect");
  const adbWifiHost = document.getElementById("adb-wifi-host");
  const adbStatusText = document.getElementById("adb-status-text");
  const isLocalPc = !window.AndroidBridge && (location.hostname === "localhost" || location.hostname === "127.0.0.1");

  async function refreshAdbStatus() {
    if (!isLocalPc || !adbPushCard) return;
    adbPushCard.style.display = "block";
    try {
      const res = await fetch("/api/adb/status");
      const data = await res.json();
      if (adbStatusText) {
        if (data.devices && data.devices.length > 0) {
          adbStatusText.innerHTML = `<span style="color:#34d399;font-weight:700;">✓ Dispositivo conectado:</span> ${data.devices.join(", ")}`;
        } else {
          adbStatusText.textContent = "Nenhum celular ADB conectado. Conecte via USB ou informe IP:Porta Wi-Fi.";
        }
      }
    } catch (e) {}
  }

  if (isLocalPc && adbPushCard) {
    adbPushCard.style.display = "block";
    if (btnAdbConnect && adbWifiHost) {
      btnAdbConnect.addEventListener("click", async () => {
        const host = adbWifiHost.value.trim();
        if (!host) return showToast("Informe IP:Porta da Depuração Sem Fio");
        btnAdbConnect.disabled = true;
        try {
          const res = await fetch("/api/adb/connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ host })
          });
          const data = await res.json();
          showToast(data.ok ? "✓ ADB Wi-Fi conectado!" : `⚠️ ${data.output || data.erro || "Falha ao conectar"}`);
          refreshAdbStatus();
        } catch (e) {
          showToast("Erro ao conectar ADB");
        } finally {
          btnAdbConnect.disabled = false;
        }
      });
    }
    if (btnAdbInstall) {
      btnAdbInstall.addEventListener("click", async () => {
        btnAdbInstall.disabled = true;
        btnAdbInstall.textContent = "⏳ Enviando...";
        try {
          const res = await fetch("/api/adb/install", { method: "POST" });
          const data = await res.json();
          if (data.ok) {
            showToast("✅ APK instalado silenciosamente no celular!");
            if (adbStatusText) adbStatusText.innerHTML = `<span style="color:#34d399;font-weight:700;">✅ Instalado sem prompts!</span>`;
          } else {
            showToast(`⚠️ ${data.erro || data.output || "Falha no deploy ADB"}`);
          }
        } catch (e) {
          showToast("Erro na instalação via ADB");
        } finally {
          btnAdbInstall.disabled = false;
          btnAdbInstall.textContent = "⚡ Enviar Agora";
        }
      });
    }
  }

  // --- AUTO-UPDATER NATIVO MORPHE-STYLE (PackageInstaller + LAN / GitHub Releases) ---
  const apkUpdaterCard = document.getElementById("apk-updater-card");
  const apkCurrentVerEl = document.getElementById("apk-current-version");
  const apkUpdateStatusEl = document.getElementById("apk-update-status");
  const apkProgressWrap = document.getElementById("apk-update-progress-wrap");
  const apkProgressBar = document.getElementById("apk-update-progress-bar");
  const updaterLanInput = document.getElementById("updater-lan-url");
  const updaterGhInput = document.getElementById("updater-gh-repo");
  const btnCheckApkUpdate = document.getElementById("btn-check-apk-update");
  const btnInstallApkUpdate = document.getElementById("btn-install-apk-update");

  let pendingApkUpdate = null;

  function compareSemverStr(a, b) {
    const pa = String(a || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const va = pa[i] || 0;
      const vb = pb[i] || 0;
      if (va > vb) return 1;
      if (va < vb) return -1;
    }
    return 0;
  }

  async function checkApkUpdates(silent = true) {
    if (!window.AndroidBridge || typeof window.AndroidBridge.getAppVersionCode !== "function") return;
    const localCode = window.AndroidBridge.getAppVersionCode();
    const localName = window.AndroidBridge.getAppVersionName();
    const lanBase = ((updaterLanInput && updaterLanInput.value) || localStorage.getItem("busradar_updater_lan") || "http://192.168.100.179:8000").trim().replace(/\/+$/, "");
    const ghRepo = ((updaterGhInput && updaterGhInput.value) || localStorage.getItem("busradar_updater_gh") || "jhona1234-del/busradar").trim();

    if (!silent && apkUpdateStatusEl) {
      apkUpdateStatusEl.textContent = "🔄 Consultando rede local e GitHub Releases...";
    }

    const candidates = [];

    // 1. Checar servidor local na rede Wi-Fi
    if (lanBase) {
      try {
        const lanData = await smartFetch(`${lanBase}/api/version`, false);
        if (lanData && lanData.versionCode) {
          const isNewer = lanData.versionCode > localCode || compareSemverStr(lanData.versionName, localName) > 0;
          if (isNewer) {
            candidates.push({
              versionCode: lanData.versionCode,
              versionName: lanData.versionName || String(lanData.versionCode),
              apkUrl: `${lanBase}${lanData.apkUrl || "/BusRadar.apk"}`,
              source: "Servidor Wi-Fi"
            });
          }
        }
      } catch (e) {}
    }

    // 2. Checar GitHub Releases
    if (ghRepo && ghRepo.includes("/")) {
      try {
        const ghData = await smartFetch(`https://api.github.com/repos/${ghRepo}/releases/latest`, false);
        if (ghData && ghData.tag_name && Array.isArray(ghData.assets)) {
          const apkAsset = ghData.assets.find((a) => String(a.name || "").toLowerCase().endsWith(".apk"));
          const verAsset = ghData.assets.find((a) => String(a.name || "").toLowerCase() === "version.json");
          let ghCode = 0;
          let ghName = String(ghData.tag_name).replace(/^v/i, "");
          if (verAsset && verAsset.browser_download_url) {
            try {
              const vJson = await smartFetch(verAsset.browser_download_url, false);
              if (vJson && vJson.versionCode) {
                ghCode = parseInt(vJson.versionCode, 10) || 0;
                if (vJson.versionName) ghName = vJson.versionName;
              }
            } catch (e) {}
          }
          const isNewer = (ghCode > localCode) || compareSemverStr(ghName, localName) > 0;
          if (isNewer && apkAsset && apkAsset.browser_download_url) {
            candidates.push({
              versionCode: ghCode,
              versionName: ghName,
              apkUrl: apkAsset.browser_download_url,
              source: "GitHub Releases"
            });
          }
        }
      } catch (e) {}
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => (b.versionCode - a.versionCode) || compareSemverStr(b.versionName, a.versionName));
      pendingApkUpdate = candidates[0];
      if (apkUpdateStatusEl) {
        apkUpdateStatusEl.innerHTML = `<span style="color:#34d399;font-weight:700;">🚀 Nova versão v${pendingApkUpdate.versionName} encontrada (${pendingApkUpdate.source})!</span>`;
      }
      if (btnInstallApkUpdate) {
        btnInstallApkUpdate.style.display = "block";
        btnInstallApkUpdate.textContent = `⚡ Atualizar p/ v${pendingApkUpdate.versionName}`;
      }
      if (silent) {
        showToast(`🚀 Atualização v${pendingApkUpdate.versionName} disponível (${pendingApkUpdate.source})! Abra "Sobre" para instalar.`);
      }
    } else {
      pendingApkUpdate = null;
      if (btnInstallApkUpdate) btnInstallApkUpdate.style.display = "none";
      if (!silent && apkUpdateStatusEl) {
        apkUpdateStatusEl.textContent = `✓ Você já está na versão mais recente (v${localName} • Build ${localCode}).`;
      }
    }
  }

  window.onNativeUpdateProgress = function (pct) {
    if (apkProgressWrap) apkProgressWrap.style.display = "block";
    if (apkProgressBar) apkProgressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    if (apkUpdateStatusEl) apkUpdateStatusEl.textContent = `📥 Baixando atualização... ${pct}%`;
  };

  window.onNativeUpdateStatus = function (ok, msg) {
    if (btnInstallApkUpdate) {
      btnInstallApkUpdate.disabled = false;
      btnInstallApkUpdate.textContent = pendingApkUpdate ? `⚡ Atualizar p/ v${pendingApkUpdate.versionName}` : "⚡ Atualizar Agora";
    }
    if (msg === "PERMISSION_REQUIRED") {
      if (apkUpdateStatusEl) {
        apkUpdateStatusEl.innerHTML = `<span style="color:#fbbf24;">⚠️ Ative <b>"Permitir desta fonte"</b> na tela do Android (apenas 1x) e toque em Atualizar novamente.</span>`;
      }
      showToast("Ative 'Permitir desta fonte' e toque novamente em Atualizar.");
      return;
    }
    if (ok) {
      if (apkProgressBar) apkProgressBar.style.width = "100%";
      if (apkUpdateStatusEl) apkUpdateStatusEl.innerHTML = `<span style="color:#34d399;font-weight:700;">✅ ${msg || "Atualizado!"}</span>`;
      showToast("✅ BusRadar atualizado!");
    } else {
      if (apkUpdateStatusEl) apkUpdateStatusEl.innerHTML = `<span style="color:#f87171;">⚠️ ${msg || "Falha ao atualizar"}</span>`;
      showToast(`⚠️ ${msg || "Falha ao atualizar"}`);
    }
  };

  if (window.AndroidBridge && typeof window.AndroidBridge.downloadAndInstallUpdate === "function" && apkUpdaterCard) {
    apkUpdaterCard.style.display = "block";
    const curVer = window.AndroidBridge.getAppVersionName();
    const curCode = window.AndroidBridge.getAppVersionCode();
    if (apkCurrentVerEl) apkCurrentVerEl.textContent = `v${curVer} (Build ${curCode})`;
    if (updaterLanInput) {
      updaterLanInput.value = localStorage.getItem("busradar_updater_lan") || "http://192.168.100.179:8000";
      updaterLanInput.addEventListener("change", () => {
        localStorage.setItem("busradar_updater_lan", updaterLanInput.value.trim());
      });
    }
    if (updaterGhInput) {
      updaterGhInput.value = localStorage.getItem("busradar_updater_gh") || "jhona1234-del/busradar";
      updaterGhInput.addEventListener("change", () => {
        localStorage.setItem("busradar_updater_gh", updaterGhInput.value.trim());
      });
    }
    if (btnCheckApkUpdate) {
      btnCheckApkUpdate.addEventListener("click", () => checkApkUpdates(false));
    }
    if (btnInstallApkUpdate) {
      btnInstallApkUpdate.addEventListener("click", () => {
        if (!pendingApkUpdate || !pendingApkUpdate.apkUrl) return;
        btnInstallApkUpdate.disabled = true;
        btnInstallApkUpdate.textContent = "⏳ Baixando...";
        if (apkProgressWrap) apkProgressWrap.style.display = "block";
        if (apkProgressBar) apkProgressBar.style.width = "4%";
        window.AndroidBridge.downloadAndInstallUpdate(pendingApkUpdate.apkUrl);
      });
    }
    setTimeout(() => checkApkUpdates(true), 4500);
  }

  if (btnAbout && aboutModal) {
    btnAbout.addEventListener("click", () => {
      aboutModal.style.display = "flex";
      refreshAdbStatus();
    });
  }

  if (btnCloseAbout && aboutModal) {
    btnCloseAbout.addEventListener("click", () => {
      aboutModal.style.display = "none";
    });
  }

  if (btnModalOk && aboutModal) {
    btnModalOk.addEventListener("click", () => {
      aboutModal.style.display = "none";
    });
  }

  // Quick Action Buttons inside About Modal (Abertos com 1 toque no ícone do app)
  if (aboutBtnOpenTileCfg) {
    aboutBtnOpenTileCfg.addEventListener("click", () => {
      if (aboutModal) aboutModal.style.display = "none";
      openTileConfigModal();
    });
  }

  if (aboutBtnOpenLog) {
    aboutBtnOpenLog.addEventListener("click", () => {
      if (aboutModal) aboutModal.style.display = "none";
      if (debugLogDrawer) {
        debugLogDrawer.classList.add("open");
        if (window.AndroidBridge && window.AndroidBridge.getLogFilePath) {
          try {
            const p = window.AndroidBridge.getLogFilePath();
            logMsg("Caminho do Log no celular: " + p);
            showToast("📋 Log gravado em: " + p);
          } catch (e) {}
        }
      }
    });
  }

  if (aboutBtnSetHome) {
    aboutBtnSetHome.addEventListener("click", () => {
      if (aboutModal) aboutModal.style.display = "none";
      openLocationPicker("home");
    });
  }

  if (aboutBtnOpenDev) {
    aboutBtnOpenDev.addEventListener("click", () => {
      if (aboutModal) aboutModal.style.display = "none";
      setDevMode(!isDevModeActive);
    });
  }

  // --- Diagnostic Log Drawer Wiring ---
  if (btnToggleLog && debugLogDrawer) {
    btnToggleLog.addEventListener("click", () => {
      debugLogDrawer.classList.toggle("open");
      if (debugLogDrawer.classList.contains("open") && window.AndroidBridge && window.AndroidBridge.getLogFilePath) {
        try {
          const path = window.AndroidBridge.getLogFilePath();
          logMsg("Caminho do Log no celular: " + path);
        } catch (e) {}
      }
    });
  }

  if (btnCloseLog && debugLogDrawer) {
    btnCloseLog.addEventListener("click", () => {
      debugLogDrawer.classList.remove("open");
    });
  }

  if (btnClearLog) {
    btnClearLog.addEventListener("click", () => {
      window.appLogs = [];
      const el = document.getElementById("debug-log-content");
      if (el) el.innerHTML = "";
      const badge = document.getElementById("log-count-badge");
      if (badge) badge.textContent = "0";
    });
  }

  // --- BOTÃO IR: Traçar Melhores Rotas sob demanda do usuário ---
  const btnCalcTrip = document.getElementById("btn-calc-trip");
  if (btnCalcTrip) {
    btnCalcTrip.addEventListener("click", () => {
      tripMatchesCalculated = true;
      btnCalcTrip.classList.remove("needs-calc");
      fetchTripMatches();
      expandPanel();
    });
  }

  // --- BOTÃO VOLTAR PARA FROTA / LINHAS NA ABA ÔNIBUS ---
  const btnBackToFleet = document.getElementById("btn-back-to-fleet");
  if (btnBackToFleet) {
    btnBackToFleet.addEventListener("click", () => {
      currentSelectedBus = null;
      if (map) map.setSelection(null, null);
      const bdc = document.getElementById("bus-details-content");
      if (bdc) bdc.style.display = "none";
      const bde = document.getElementById("bus-details-empty");
      if (bde && activeRoutes.size === 0) bde.style.display = "block";
      const trackedSec = document.getElementById("tracked-lines-section");
      if (trackedSec) trackedSec.scrollIntoView({ behavior: "smooth" });
    });
  }

  // Auto-refresh moving buses every 10 seconds (Apenas coordenadas de ônibus, sem piscar e sem recalcular rotas pesadas)
  setInterval(() => {
    if (!isSimulationActive) {
      if (map) {
        const center = map.getCenter();
        fetchBusesAround(center.lat, center.lng);
      }
      // Atualiza frota em tempo real de todas as rotas ativas
      for (const iti of activeRoutes.keys()) {
        fetchBusesForIti(iti);
      }
    }
  }, 10000);

  // Initialize immediately or on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMap);
  } else {
    initMap();
  }
})();
