package com.kilosaurus.temps;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Appel à l'API Apps Script. Google répond à un POST par une redirection (302) vers l'adresse qui
 * porte la réponse : on suit cette redirection à la main, en GET, pour ne dépendre d'aucun
 * comportement implicite de HttpURLConnection.
 */
final class Api {
    static final String DEFAULT_URL =
        "https://script.google.com/macros/s/AKfycbymtz045MJ4nZKm1scGElvtfiyAlb3WPzb9UEm4K_xiylXgADZdrFJsQaOINctJ5rNOKQ/exec";

    // Apps Script répond d'habitude en 1 à 4 s, mais monte parfois à 30 s (démarrage à froid, Sheet
    // occupée). Le widget travaille en arrière-plan (goAsync), il peut se permettre d'attendre.
    private static final int CONNECT_TIMEOUT_MS = 10000;
    private static final int READ_TIMEOUT_MS = 20000;

    /** Échec d'appel. kind : network, timeout, http, format, ou le code d'erreur de l'API (unauthorized, invalid, busy, server). */
    static final class ApiException extends Exception {
        final String kind;

        ApiException(String kind, String message) {
            super(message);
            this.kind = kind;
        }
    }

    private Api() {}

    static JSONObject call(String url, JSONObject body) throws ApiException {
        String text;
        try {
            HttpURLConnection post = open(url);
            post.setRequestMethod("POST");
            post.setDoOutput(true);
            post.setRequestProperty("Content-Type", "text/plain;charset=utf-8");
            try (OutputStream out = post.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = post.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = post.getHeaderField("Location");
                post.disconnect();
                if (location == null) throw new ApiException("http", "Redirection sans adresse.");
                HttpURLConnection get = open(location);
                get.setInstanceFollowRedirects(true);
                code = get.getResponseCode();
                if (code != 200) throw new ApiException("http", "Le serveur répond « " + code + " ».");
                text = read(get);
            } else if (code == 200) {
                text = read(post);
            } else {
                throw new ApiException("http", "Le serveur répond « " + code + " ».");
            }
        } catch (SocketTimeoutException e) {
            throw new ApiException("timeout", "Pas de réponse du serveur. Vérifie l’état avant de réessayer.");
        } catch (IOException e) {
            throw new ApiException("network", "Pas de réseau : rien n’est enregistré.");
        }

        JSONObject res;
        try {
            res = new JSONObject(text);
        } catch (JSONException e) {
            throw new ApiException("format", "Réponse inattendue du serveur.");
        }
        if (!res.optBoolean("ok")) {
            JSONObject err = res.optJSONObject("error");
            String kind = err != null ? err.optString("code", "server") : "server";
            String message = err != null ? err.optString("message", "") : "";
            throw new ApiException(kind, message);
        }
        JSONObject data = res.optJSONObject("data");
        if (data == null) throw new ApiException("format", "Réponse inattendue du serveur.");
        return data;
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(CONNECT_TIMEOUT_MS);
        c.setReadTimeout(READ_TIMEOUT_MS);
        c.setInstanceFollowRedirects(false);
        return c;
    }

    private static String read(HttpURLConnection c) throws IOException {
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            c.disconnect();
        }
    }
}
