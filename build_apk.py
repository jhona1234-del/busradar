#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys

VERSION_CODE = 33
VERSION_NAME = "2.5.8"

WORKSPACE = os.path.dirname(os.path.abspath(__file__))
IS_WIN = os.name == "nt"
DEFAULT_WIN_SDK = r"C:\Users\Jhonatan\AppData\Local\Android\Sdk"
SDK_DIR = (
    os.environ.get("ANDROID_HOME")
    or os.environ.get("ANDROID_SDK_ROOT")
    or (DEFAULT_WIN_SDK if IS_WIN else os.path.expanduser("~/Android/Sdk"))
)
BUILD_TOOLS_DIR = os.path.join(SDK_DIR, "build-tools", "34.0.0")
EXE = ".exe" if IS_WIN else ""
BAT = ".bat" if IS_WIN else ""
AAPT = os.path.join(BUILD_TOOLS_DIR, f"aapt{EXE}")
AAPT2 = os.path.join(BUILD_TOOLS_DIR, f"aapt2{EXE}")
D8 = os.path.join(BUILD_TOOLS_DIR, f"d8{BAT}")
ZIPALIGN = os.path.join(BUILD_TOOLS_DIR, f"zipalign{EXE}")
APKSIGNER = os.path.join(BUILD_TOOLS_DIR, f"apksigner{BAT}")
PLATFORM_JAR = os.path.join(SDK_DIR, "platforms", "android-34", "android.jar")

BUILD_DIR = os.path.join(WORKSPACE, "build")
SRC_DIR = os.path.join(BUILD_DIR, "src")
GEN_DIR = os.path.join(BUILD_DIR, "gen")
OBJ_DIR = os.path.join(BUILD_DIR, "obj")
RES_DIR = os.path.join(BUILD_DIR, "res")
ASSETS_DIR = os.path.join(BUILD_DIR, "assets")
FINAL_APK = os.path.join(WORKSPACE, "BusRadar.apk")

print("=========================================")
print(f"  Compilando BusRadar.apk v{VERSION_NAME} (Build {VERSION_CODE})")
print("=========================================")

# Clean build directory
shutil.rmtree(BUILD_DIR, ignore_errors=True)
for d in [
    SRC_DIR,
    GEN_DIR,
    OBJ_DIR,
    RES_DIR,
    os.path.join(RES_DIR, "values"),
    os.path.join(RES_DIR, "xml"),
    ASSETS_DIR,
]:
    os.makedirs(d, exist_ok=True)

# 1. Copy web assets to APK assets/
STATIC_DIR = os.path.join(WORKSPACE, "static")
for root, _, files in os.walk(STATIC_DIR):
    rel_path = os.path.relpath(root, STATIC_DIR)
    target_dir = os.path.join(ASSETS_DIR, rel_path) if rel_path != "." else ASSETS_DIR
    os.makedirs(target_dir, exist_ok=True)
    for f in files:
        if not f.endswith(".apk"):
            shutil.copy2(os.path.join(root, f), os.path.join(target_dir, f))

# Generate Multi-Density Launcher Icons
from PIL import Image

icon_src = os.path.join(STATIC_DIR, "icon.png")
if os.path.exists(icon_src):
    base_img = Image.open(icon_src)
    densities = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, px in densities.items():
        target_f = os.path.join(RES_DIR, folder)
        os.makedirs(target_f, exist_ok=True)
        resized = base_img.resize((px, px), Image.Resampling.LANCZOS)
        resized.save(os.path.join(target_f, "ic_launcher.png"), "PNG")
        resized.save(os.path.join(target_f, "ic_launcher_round.png"), "PNG")
    print("[1/7] Ícones multi-densidade gerados (MDPI a XXXHDPI)")
else:
    print("[1/7] Aviso: icon.png não encontrado!")

print(f"[1/7] Assets preparados ({len(os.listdir(ASSETS_DIR))} itens)")

# 2. network_security_config.xml
net_sec_config = """<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>"""
with open(os.path.join(RES_DIR, "xml", "network_security_config.xml"), "w", encoding="utf-8") as f:
    f.write(net_sec_config)

# 3. AndroidManifest.xml (Android 8.0+ até Android 17 + Self-Updater PackageInstaller)
manifest_content = f"""<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.busradar"
    android:versionCode="{VERSION_CODE}"
    android:versionName="{VERSION_NAME}">

    <uses-sdk
        android:minSdkVersion="26"
        android:targetSdkVersion="34" />

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
    <uses-permission android:name="android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION" />

    <application
        android:label="BusRadar"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:hardwareAccelerated="true"
        android:largeHeap="true"
        android:networkSecurityConfig="@xml/network_security_config"
        android:usesCleartextTraffic="true"
        android:hasCode="true"
        android:theme="@android:style/Theme.NoTitleBar">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:hardwareAccelerated="true"
            android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <receiver
            android:name=".InstallReceiver"
            android:exported="false" />
    </application>
</manifest>"""

with open(os.path.join(BUILD_DIR, "AndroidManifest.xml"), "w", encoding="utf-8") as f:
    f.write(manifest_content)

with open(os.path.join(RES_DIR, "values", "strings.xml"), "w", encoding="utf-8") as f:
    f.write('<resources><string name="app_name">BusRadar</string></resources>')

# 4. InstallReceiver.java & MainActivity.java
pkg_dir = os.path.join(SRC_DIR, "com", "busradar")
os.makedirs(pkg_dir, exist_ok=True)

receiver_code = """package com.busradar;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;

public class InstallReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        Log.d("BusRadarInstall", "Status=" + status + " msg=" + msg);

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmIntent = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmIntent != null) {
                confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(confirmIntent);
            }
        } else if (status == PackageInstaller.STATUS_SUCCESS) {
            MainActivity.notifyUpdateResult(true, "Atualizacao instalada com sucesso!");
        } else {
            String err = (msg != null && !msg.isEmpty()) ? msg : ("Erro codigo " + status);
            MainActivity.notifyUpdateResult(false, err);
        }
    }
}
"""
with open(os.path.join(pkg_dir, "InstallReceiver.java"), "w", encoding="utf-8") as f:
    f.write(receiver_code)

java_code = """package com.busradar;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity implements LocationListener {
    private static MainActivity currentInstance = null;
    private WebView webView;
    private LocationManager locationManager;
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private static final int PERM_CODE = 100;
    private File appLogFile = null;
    private File docLogFile = null;

    public static void notifyUpdateResult(final boolean ok, final String message) {
        final MainActivity act = currentInstance;
        if (act != null) {
            act.log("UPDATER", (ok ? "OK: " : "ERR: ") + message);
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (act.webView != null) {
                        String safeMsg = message == null ? "" : message.replace("'", "\\\\'").replace("\\n", " ");
                        String script = "if (window.onNativeUpdateStatus) { window.onNativeUpdateStatus(" + ok + ", '" + safeMsg + "'); }";
                        act.webView.evaluateJavascript(script, null);
                    }
                }
            });
        }
    }

    public void log(String tag, String msg) {
        String timestamp = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(new Date());
        String logLine = "[" + timestamp + "] [" + tag + "] " + msg;
        Log.d("BusRadar", logLine);

        try {
            if (appLogFile != null) {
                FileWriter fw = new FileWriter(appLogFile, true);
                fw.write(logLine + "\\n");
                fw.close();
            }
        } catch (Throwable ignored) {}

        try {
            if (docLogFile != null) {
                FileWriter fw = new FileWriter(docLogFile, true);
                fw.write(logLine + "\\n");
                fw.close();
            }
        } catch (Throwable ignored) {}
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        currentInstance = this;
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        try {
            File extDir = getExternalFilesDir(null);
            if (extDir != null) {
                appLogFile = new File(extDir, "BusRadar_log.txt");
            }
        } catch (Throwable ignored) {}

        try {
            File docsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
            if (docsDir != null && (docsDir.exists() || docsDir.mkdirs())) {
                docLogFile = new File(docsDir, "BusRadar_log.txt");
            }
        } catch (Throwable ignored) {}

        log("SYSTEM", "BusRadar v__VERSION_NAME__ iniciando no Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")");

        if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            log("PERM", "Solicitando permissoes de localizacao...");
            requestPermissions(new String[]{
                android.Manifest.permission.ACCESS_FINE_LOCATION,
                android.Manifest.permission.ACCESS_COARSE_LOCATION
            }, PERM_CODE);
        } else {
            log("PERM", "Permissao de localizacao ja concedida.");
        }

        webView = new WebView(this);
        webView.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setRenderPriority(WebSettings.RenderPriority.HIGH);
        settings.setEnableSmoothTransition(true);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                log("GEO", "Geolocalizacao solicitada por: " + origin);
                callback.invoke(origin, true, false);
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                String lvl = cm.messageLevel() != null ? cm.messageLevel().name() : "LOG";
                String src = cm.sourceId() != null ? cm.sourceId() : "app";
                if (src.contains("/")) src = src.substring(src.lastIndexOf("/") + 1);
                log("JS_" + lvl, cm.message() + " (" + src + ":" + cm.lineNumber() + ")");
                return true;
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                log("WEBVIEW", "Iniciando carregamento: " + url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                log("WEBVIEW", "Pagina carregada com sucesso: " + url);
                startLocationUpdates();
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                log("WEBVIEW_ERR", "Erro (" + errorCode + "): " + description + " na URL: " + failingUrl);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.getUrl() != null) {
                    log("WEBVIEW_ERR", "Falha de recurso: " + request.getUrl().toString());
                }
            }
        });

        log("WEBVIEW", "Carregando file:///android_asset/index.html");
        webView.loadUrl("file:///android_asset/index.html");
        setContentView(webView);

        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        startLocationUpdates();
    }

    @Override
    protected void onDestroy() {
        if (currentInstance == this) {
            currentInstance = null;
        }
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERM_CODE) {
            boolean granted = (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED);
            log("PERM", "Resultado da permissao: " + (granted ? "CONCEDIDA" : "NEGADA"));
            if (granted) {
                startLocationUpdates();
            }
        }
    }

    public void startLocationUpdates() {
        if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            log("GPS", "Aviso: Sem permissao de localizacao ainda.");
            return;
        }

        try {
            if (locationManager != null) {
                Location lastGps = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                Location lastNet = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                Location best = null;
                if (lastGps != null && lastNet != null) {
                    best = (lastGps.getTime() >= lastNet.getTime()) ? lastGps : lastNet;
                } else {
                    best = (lastGps != null) ? lastGps : lastNet;
                }
                if (best != null) {
                    log("GPS", "Localizacao rapida em cache encontrada: " + best.getLatitude() + ", " + best.getLongitude());
                    sendLocationToJs(best.getLatitude(), best.getLongitude());
                }

                if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    log("GPS", "Assinando provedor GPS...");
                    locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 3000, 5, this);
                }
                if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    log("GPS", "Assinando provedor REDE...");
                    locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 3000, 5, this);
                }
            }
        } catch (Exception e) {
            log("GPS_ERR", "Erro ao iniciar LocationManager: " + e.getMessage());
        }
    }

    public void sendLocationToJs(final double lat, final double lng) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView != null) {
                    String script = "if (window.onNativeGpsLocation) { window.onNativeGpsLocation(" + lat + ", " + lng + "); }";
                    webView.evaluateJavascript(script, null);
                }
            }
        });
    }

    @Override
    public void onLocationChanged(Location location) {
        if (location != null) {
            log("GPS_UPDATE", "Coordenadas: " + location.getLatitude() + ", " + location.getLongitude() + " (precisao: " + location.getAccuracy() + "m)");
            sendLocationToJs(location.getLatitude(), location.getLongitude());
        }
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {
        log("GPS", "Provedor ativado: " + provider);
    }

    @Override
    public void onProviderDisabled(String provider) {
        log("GPS", "Provedor desativado: " + provider);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    public class AndroidBridge {
        @JavascriptInterface
        public int getAppVersionCode() {
            return __VERSION_CODE__;
        }

        @JavascriptInterface
        public String getAppVersionName() {
            return "__VERSION_NAME__";
        }

        @JavascriptInterface
        public boolean canInstallPackages() {
            if (Build.VERSION.SDK_INT >= 26) {
                return getPackageManager().canRequestPackageInstalls();
            }
            return true;
        }

        @JavascriptInterface
        public void openInstallPermissionSettings() {
            if (Build.VERSION.SDK_INT >= 26) {
                Intent i = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())
                );
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            }
        }

        @JavascriptInterface
        public void downloadAndInstallUpdate(final String apkUrl) {
            executor.submit(new Runnable() {
                @Override
                public void run() {
                    if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                        openInstallPermissionSettings();
                        notifyUpdateResult(false, "PERMISSION_REQUIRED");
                        return;
                    }

                    PackageInstaller.Session session = null;
                    try {
                        log("UPDATER", "Baixando atualizacao de: " + apkUrl);
                        String curUrl = apkUrl;
                        HttpURLConnection conn = null;
                        for (int hop = 0; hop < 6; hop++) {
                            URL u = new URL(curUrl);
                            conn = (HttpURLConnection) u.openConnection();
                            conn.setInstanceFollowRedirects(false);
                            conn.setConnectTimeout(15000);
                            conn.setReadTimeout(30000);
                            conn.setRequestProperty("User-Agent", "BusRadar-Updater/__VERSION_NAME__");
                            int code = conn.getResponseCode();
                            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                                String loc = conn.getHeaderField("Location");
                                conn.disconnect();
                                if (loc == null || loc.isEmpty()) break;
                                curUrl = new URL(u, loc).toString();
                                continue;
                            }
                            break;
                        }

                        if (conn == null || conn.getResponseCode() >= 400) {
                            notifyUpdateResult(false, "Falha HTTP ao baixar APK (" + (conn != null ? conn.getResponseCode() : -1) + ")");
                            return;
                        }

                        int totalLen = conn.getContentLength();
                        File apkFile = new File(getCacheDir(), "BusRadar_update.apk");
                        InputStream is = conn.getInputStream();
                        FileOutputStream fos = new FileOutputStream(apkFile);
                        byte[] buf = new byte[16384];
                        int n;
                        long downloaded = 0;
                        int lastPct = -1;
                        while ((n = is.read(buf)) != -1) {
                            fos.write(buf, 0, n);
                            downloaded += n;
                            if (totalLen > 0) {
                                final int pct = (int) ((downloaded * 100L) / totalLen);
                                if (pct != lastPct && (pct % 5 == 0 || pct == 100)) {
                                    lastPct = pct;
                                    runOnUiThread(new Runnable() {
                                        @Override
                                        public void run() {
                                            if (webView != null) {
                                                webView.evaluateJavascript("if (window.onNativeUpdateProgress) { window.onNativeUpdateProgress(" + pct + "); }", null);
                                            }
                                        }
                                    });
                                }
                            }
                        }
                        fos.flush();
                        fos.close();
                        is.close();
                        conn.disconnect();

                        if (!apkFile.exists() || apkFile.length() < 50000) {
                            notifyUpdateResult(false, "Arquivo APK baixado invalido ou incompleto.");
                            return;
                        }

                        log("UPDATER", "Download concluido (" + apkFile.length() + " bytes). Iniciando PackageInstaller...");
                        PackageInstaller pi = getPackageManager().getPackageInstaller();
                        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                            PackageInstaller.SessionParams.MODE_FULL_INSTALL
                        );
                        params.setAppPackageName(getPackageName());
                        if (Build.VERSION.SDK_INT >= 31) {
                            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                        }
                        params.setSize(apkFile.length());

                        int sessionId = pi.createSession(params);
                        session = pi.openSession(sessionId);
                        OutputStream sos = session.openWrite("busradar_update", 0, apkFile.length());
                        FileInputStream fis = new FileInputStream(apkFile);
                        while ((n = fis.read(buf)) > 0) {
                            sos.write(buf, 0, n);
                        }
                        session.fsync(sos);
                        fis.close();
                        sos.close();

                        Intent cbIntent = new Intent(MainActivity.this, InstallReceiver.class);
                        int pFlags = PendingIntent.FLAG_UPDATE_CURRENT;
                        if (Build.VERSION.SDK_INT >= 31) {
                            pFlags |= PendingIntent.FLAG_MUTABLE;
                        }
                        PendingIntent piSender = PendingIntent.getBroadcast(MainActivity.this, sessionId, cbIntent, pFlags);
                        session.commit(piSender.getIntentSender());
                        session.close();
                        session = null;
                    } catch (Throwable t) {
                        log("UPDATER_ERR", "Erro updater: " + t.getMessage());
                        if (session != null) {
                            try { session.abandon(); } catch (Throwable ignored) {}
                        }
                        notifyUpdateResult(false, "Erro ao instalar: " + t.getMessage());
                    }
                }
            });
        }

        @JavascriptInterface
        public void log(String tag, String msg) {
            MainActivity.this.log(tag, msg);
        }

        @JavascriptInterface
        public String getLogFilePath() {
            String p1 = appLogFile != null ? appLogFile.getAbsolutePath() : "";
            String p2 = docLogFile != null ? docLogFile.getAbsolutePath() : "";
            return p2.length() > 0 ? p2 : p1;
        }

        @JavascriptInterface
        public void requestGpsLocation() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startLocationUpdates();
                }
            });
        }

        @JavascriptInterface
        public void httpGetAsync(final String reqId, final String urlStr) {
            executor.submit(new Runnable() {
                @Override
                public void run() {
                    int code = -1;
                    String body = "";
                    try {
                        URL u = new URL(urlStr);
                        HttpURLConnection conn = (HttpURLConnection) u.openConnection();
                        conn.setConnectTimeout(8000);
                        conn.setReadTimeout(8000);
                        conn.setRequestMethod("GET");
                        conn.setRequestProperty("User-Agent", "BusRadar-Mobile/1.6");
                        code = conn.getResponseCode();
                        InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
                        if (is != null) {
                            BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"));
                            StringBuilder sb = new StringBuilder();
                            String line;
                            while ((line = br.readLine()) != null) {
                                sb.append(line).append("\\n");
                            }
                            br.close();
                            body = sb.toString();
                        }
                    } catch (Exception e) {
                        body = "{\\"error\\":\\"" + e.getMessage() + "\\"}";
                    }

                    try {
                        final int fCode = code;
                        final String b64 = Base64.encodeToString(body.getBytes("UTF-8"), Base64.NO_WRAP);
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if (webView != null) {
                                    String script = "if (window.onNativeHttpResponse) { window.onNativeHttpResponse('" + reqId + "', " + fCode + ", '" + b64 + "'); }";
                                    webView.evaluateJavascript(script, null);
                                }
                            }
                        });
                    } catch (Exception ignored) {}
                }
            });
        }
    }
}
"""
java_code = java_code.replace("__VERSION_CODE__", str(VERSION_CODE)).replace("__VERSION_NAME__", VERSION_NAME)
with open(os.path.join(pkg_dir, "MainActivity.java"), "w", encoding="utf-8") as f:
    f.write(java_code)

print("[2/7] Código Java e Manifesto preparados")

# 5. Compile resources with aapt2
res_zip = os.path.join(BUILD_DIR, "res.zip")
subprocess.run([AAPT2, "compile", "--dir", RES_DIR, "-o", res_zip], check=True, stdout=subprocess.DEVNULL)

unaligned_apk = os.path.join(BUILD_DIR, "unaligned.apk")
cmd_aapt2_link = [
    AAPT2, "link",
    "-I", PLATFORM_JAR,
    "--manifest", os.path.join(BUILD_DIR, "AndroidManifest.xml"),
    "--java", GEN_DIR,
    "-o", unaligned_apk,
    "-A", ASSETS_DIR,
    res_zip
]
subprocess.run(cmd_aapt2_link, check=True, stdout=subprocess.DEVNULL)
print("[3/7] Recursos e assets vinculados (AAPT2)")

# 6. Javac
r_java = os.path.join(GEN_DIR, "com", "busradar", "R.java")
sources = [
    os.path.join(pkg_dir, "MainActivity.java"),
    os.path.join(pkg_dir, "InstallReceiver.java"),
]
if os.path.exists(r_java):
    sources.append(r_java)

cmd_javac = [
    "javac",
    "-encoding", "UTF-8",
    "-source", "1.8",
    "-target", "1.8",
    "-bootclasspath", PLATFORM_JAR,
    "-d", OBJ_DIR
] + sources
subprocess.run(cmd_javac, check=True, stdout=subprocess.DEVNULL)
print("[4/7] Código Java compilado (Javac)")

# 7. D8 Dexing
class_files = []
for root, _, files in os.walk(OBJ_DIR):
    for fl in files:
        if fl.endswith(".class"):
            class_files.append(os.path.join(root, fl))

cmd_d8 = [D8, "--lib", PLATFORM_JAR, "--output", BUILD_DIR] + class_files
subprocess.run(cmd_d8, shell=IS_WIN, check=True, stdout=subprocess.DEVNULL)

subprocess.run([AAPT, "add", unaligned_apk, "classes.dex"], cwd=BUILD_DIR, check=True, stdout=subprocess.DEVNULL)
print("[5/7] Bytecode DEX gerado e inserido com aapt (D8)")

# 8. Zipalign
aligned_apk = os.path.join(BUILD_DIR, "aligned.apk")
subprocess.run([ZIPALIGN, "-p", "-f", "4", unaligned_apk, aligned_apk], check=True)
print("[6/7] Alinhamento 4-byte verificado (Zipalign)")

# 9. Keystore & Signing (Credenciais lidas de variáveis de ambiente ou .env.keystore local)
env_file = os.path.join(WORKSPACE, ".env.keystore")
if os.path.exists(env_file):
    with open(env_file, "r", encoding="utf-8") as ef:
        for line in ef:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

ks_alias = os.environ.get("KEYSTORE_ALIAS")
ks_pass = os.environ.get("KEYSTORE_PASS")
key_pass = os.environ.get("KEY_PASS") or ks_pass
keystore_path = os.path.join(WORKSPACE, "release.keystore")

if not ks_alias or not ks_pass:
    if os.path.exists(keystore_path):
        raise RuntimeError("KEYSTORE_ALIAS e KEYSTORE_PASS são obrigatórios para assinar com release.keystore existente.")
    # Fallback efêmero apenas para testes locais sem release.keystore
    ks_alias = "busradardev"
    ks_pass = "devtemp1234"
    key_pass = "devtemp1234"
    keystore_path = os.path.join(BUILD_DIR, "debug-temp.keystore")

if not os.path.exists(keystore_path):
    print("Gerando chave criptográfica...")
    cmd_keytool = [
        "keytool", "-genkey", "-v",
        "-keystore", keystore_path,
        "-alias", ks_alias,
        "-storepass", ks_pass,
        "-keypass", key_pass,
        "-keyalg", "RSA",
        "-keysize", "2048",
        "-validity", "10000",
        "-dname", "CN=BusRadar Enterprise,O=BusRadar,C=BR"
    ]
    subprocess.run(cmd_keytool, check=True, stdout=subprocess.DEVNULL)

cmd_apksigner = [
    APKSIGNER, "sign",
    "--v1-signing-enabled", "true",
    "--v2-signing-enabled", "true",
    "--v3-signing-enabled", "true",
    "--ks", keystore_path,
    "--ks-pass", f"pass:{ks_pass}",
    "--key-pass", f"pass:{key_pass}",
    "--ks-key-alias", ks_alias,
    "--out", FINAL_APK,
    aligned_apk
]
subprocess.run(cmd_apksigner, shell=IS_WIN, check=True, stdout=subprocess.DEVNULL)

# Copy APK to static/ and write version.json manifest
shutil.copy2(FINAL_APK, os.path.join(STATIC_DIR, "BusRadar.apk"))
version_meta = {
    "versionCode": VERSION_CODE,
    "versionName": VERSION_NAME,
    "apkName": "BusRadar.apk",
}
for v_path in [os.path.join(WORKSPACE, "version.json"), os.path.join(STATIC_DIR, "version.json")]:
    with open(v_path, "w", encoding="utf-8") as vf:
        json.dump(version_meta, vf, indent=2)

print("[7/7] APK assinado com sucesso!")
print("=========================================")
print(f"  [+] APK PRONTO: {FINAL_APK}")
print(f"  [+] Versão:     v{VERSION_NAME} (Build {VERSION_CODE})")
print(f"  [+] Cópia Web:  {os.path.join(STATIC_DIR, 'BusRadar.apk')}")
print(f"  [+] Tamanho:    {os.path.getsize(FINAL_APK) / 1024:.1f} KB")
print("=========================================")

if "--install" in sys.argv:
    adb_exe = os.path.join(SDK_DIR, "platform-tools", f"adb{EXE}")
    if not os.path.exists(adb_exe):
        adb_exe = shutil.which("adb") or "adb"
    print("[+] Enviando BusRadar.apk silenciosamente via ADB...")
    res = subprocess.run([adb_exe, "install", "-r", "-d", FINAL_APK], capture_output=True, text=True)
    print(res.stdout.strip() or res.stderr.strip())
