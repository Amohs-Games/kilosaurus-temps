package com.kilosaurus.temps;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.DisplayCutout;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;

/**
 * L'app complète : l'interface web (dossier web/ du dépôt, copié dans les assets de l'APK) dans
 * une WebView. Les fichiers sont servis sous une adresse https interne (APP_HOST) plutôt qu'en
 * file:// : la page a ainsi une origine normale, ce que demandent les appels à l'API et le stockage.
 */
public class MainActivity extends Activity {
    private static final String APP_HOST = "app.kilosaurus.local";
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.addJavascriptInterface(new Bridge(), "KTAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                if (!APP_HOST.equals(req.getUrl().getHost())) return null;
                String path = req.getUrl().getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                try {
                    InputStream in = getAssets().open("web" + path);
                    return new WebResourceResponse(mime(path), "utf-8", in);
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
                }
            }
        });
        // Les marges des barres système vont sur un cadre autour de la page : une WebView dessine
        // son contenu sans tenir compte de ses propres marges.
        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        padForSystemBars(root);
        setContentView(root);
        if (state == null) web.loadUrl("https://" + APP_HOST + "/index.html");
        else web.restoreState(state);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Les taps du widget encore en file partent maintenant (le réseau est sans doute là).
        sendBroadcast(new Intent(this, WidgetProvider.class).setAction(WidgetProvider.ACTION_REFRESH));
        // L'état a pu changer via le widget : la page se recharge depuis le serveur.
        web.evaluateJavascript("window.dispatchEvent(new Event('online'))", null);
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    static void padForSystemBars(View view) {
        view.setOnApplyWindowInsetsListener((v, insets) -> {
            int top, bottom, left, right;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                top = bars.top; bottom = bars.bottom; left = bars.left; right = bars.right;
            } else {
                top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom();
                left = insets.getSystemWindowInsetLeft(); right = insets.getSystemWindowInsetRight();
                DisplayCutout cut = Build.VERSION.SDK_INT >= 28 ? insets.getDisplayCutout() : null;
                if (cut != null) {
                    top = Math.max(top, cut.getSafeInsetTop()); bottom = Math.max(bottom, cut.getSafeInsetBottom());
                    left = Math.max(left, cut.getSafeInsetLeft()); right = Math.max(right, cut.getSafeInsetRight());
                }
            }
            v.setPadding(left, top, right, bottom);
            // Consommées ici : la page ne les ajoute pas une seconde fois (env(safe-area-inset-*)).
            return Build.VERSION.SDK_INT >= 30 ? WindowInsets.CONSUMED : insets.consumeSystemWindowInsets();
        });
    }

    /** Pont appelé par la page (web/app.js) : partage le code et l'état avec le widget. */
    private final class Bridge {
        @JavascriptInterface
        public void setCode(String code) {
            new Prefs(MainActivity.this).setCode(code == null ? "" : code);
        }

        @JavascriptInterface
        public void onStatus(String json) {
            try {
                Prefs p = new Prefs(MainActivity.this);
                p.saveStatus(new JSONObject(json));
                p.setMessage("");
                WidgetProvider.renderAll(MainActivity.this);
            } catch (JSONException ignored) {
                // Un état illisible ne doit pas casser l'app ; le widget se resynchronise seul.
            }
        }
    }
}
