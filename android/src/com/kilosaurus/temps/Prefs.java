package com.kilosaurus.temps;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

/**
 * Réglages et état affiché, stockés sur le téléphone.
 * Le code et l'URL sont propres à l'appareil ; le projet est propre à chaque widget posé.
 * L'état « compteur en cours » et le total du jour sont ceux de la personne, partagés par tous ses
 * widgets. Le widget change cet état lui-même au tap ; la file `queue` porte les actions pas encore
 * confirmées par le serveur, et tant qu'elle n'est pas vide, l'état du serveur ne l'écrase pas.
 *
 * Deux repères évitent de comparer l'horloge du téléphone à celle du serveur :
 *  - tapSeq compte les taps : un état lu avant un tap n'est jamais appliqué après lui ;
 *  - clockOffset est l'écart entre les deux horloges, mesuré à chaque réponse : l'heure d'un tap et
 *    les chronos sont calculés à l'heure du serveur, même si le téléphone avance ou retarde.
 */
final class Prefs {
    private static final long HOUR_MS = 3600000L;
    private final SharedPreferences sp;

    Prefs(Context ctx) {
        sp = ctx.getSharedPreferences("kt", Context.MODE_PRIVATE);
    }

    String code() { return sp.getString("code", ""); }
    String me() { return sp.getString("me", ""); }
    String message() { return sp.getString("message", ""); }

    /** Adresse de l'API. Celle de la v1 (Apps Script), gardée par un widget réglé avant la v2, est remplacée. */
    String url() {
        String u = sp.getString("url", Api.DEFAULT_URL);
        return u.contains("script.google.com") ? Api.DEFAULT_URL : u;
    }

    void setAccess(String code, String url) {
        sp.edit().putString("code", code.trim()).putString("url", url.trim()).apply();
    }

    void setCode(String code) {
        sp.edit().putString("code", code.trim()).apply();
    }

    void setMessage(String message) {
        sp.edit().putString("message", message).apply();
    }

    String widgetProject(int widgetId) { return sp.getString("project_" + widgetId, ""); }

    void setWidgetProject(int widgetId, String project) {
        sp.edit().putString("project_" + widgetId, project).apply();
    }

    void forgetWidget(int widgetId) {
        sp.edit().remove("project_" + widgetId).apply();
    }

    // ---- Repères ----

    int tapSeq() { return sp.getInt("tapSeq", 0); }

    /** Heure du serveur, estimée : l'horloge du téléphone corrigée de l'écart mesuré à la dernière réponse. */
    long serverNow() { return System.currentTimeMillis() + sp.getLong("clockOffset", 0); }

    /** Seuil d'oubli (réglage du serveur, 8 h par défaut). */
    long thresholdMs() { return sp.getLong("thresholdMs", 8 * HOUR_MS); }

    // ---- Compteur en cours ----

    boolean isRunning() { return sp.getLong("runningStart", 0) > 0; }
    String runningProject() { return sp.getString("runningProject", ""); }
    long runningStart() { return sp.getLong("runningStart", 0); }
    String runningType() { return canonicalType(sp.getString("runningType", "Misc")); }

    /** Noms de la première version (Autre, Narration), encore possibles dans un état mémorisé. */
    static String canonicalType(String type) {
        if ("Autre".equals(type)) return "Misc";
        if ("Narration".equals(type)) return "Writing";
        return type;
    }

    /** Lance le compteur affiché, sans attendre le serveur. */
    void startLocal(String project, String type, long at) {
        sp.edit().putString("runningProject", project).putString("runningType", type).putLong("runningStart", at)
            .putInt("tapSeq", tapSeq() + 1).apply();
    }

    /** Arrête le compteur affiché, sans attendre le serveur ; sa part d'aujourd'hui rejoint le total du jour. */
    void stopLocal(long at) {
        long from = Math.max(runningStart(), startOfToday());
        long done = todayDoneMs() + Math.max(0, at - from);
        sp.edit().remove("runningProject").remove("runningType").remove("runningStart")
            .putString("todayKey", todayKey()).putLong("todayDoneMs", done).putInt("tapSeq", tapSeq() + 1).apply();
    }

    // ---- Total du jour ----

    static String todayKey() { return LocalDate.now().toString(); }

    static long startOfToday() {
        return LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli();
    }

    /** Temps du jour hors compteur en cours (sessions terminées découpées à minuit, blocs du jour). */
    long todayDoneMs() {
        return todayKey().equals(sp.getString("todayKey", "")) ? sp.getLong("todayDoneMs", 0) : 0;
    }

    // ---- File des actions pas encore confirmées ----

    JSONArray queue() {
        try { return new JSONArray(sp.getString("queue", "[]")); } catch (JSONException e) { return new JSONArray(); }
    }

    void setQueue(JSONArray q) {
        sp.edit().putString("queue", q.toString()).commit();
    }

    // ---- État renvoyé par le serveur ----

    /**
     * Mémorise l'état renvoyé par l'API. L'écart d'horloge et le seuil d'oubli sont toujours pris. Le
     * compteur et le total du jour ne le sont que si aucune action du widget n'attend et qu'aucun tap
     * n'a eu lieu depuis l'envoi de la requête (seqAtSend) : sinon cet état précède ce que le widget
     * montre, et l'appliquer rallumerait ou éteindrait le compteur à tort.
     */
    void saveStatus(JSONObject data, int seqAtSend) {
        SharedPreferences.Editor e = sp.edit().putString("me", data.optString("me", ""));
        String serverTime = data.optString("serverTime", "");
        if (!serverTime.isEmpty()) {
            try {
                e.putLong("clockOffset", Instant.parse(serverTime).toEpochMilli() - System.currentTimeMillis());
            } catch (RuntimeException ignored) {
                // Heure illisible : l'écart précédent reste.
            }
        }
        if (data.has("threshold")) e.putLong("thresholdMs", Math.round(data.optDouble("threshold", 8) * HOUR_MS));
        if (queue().length() > 0 || tapSeq() != seqAtSend) { e.apply(); return; }
        JSONObject running = data.optJSONObject("running");
        if (running != null) {
            e.putString("runningProject", running.optString("project", ""));
            e.putString("runningType", running.optString("type", "Misc"));
            e.putLong("runningStart", Instant.parse(running.optString("start")).toEpochMilli());
        } else {
            e.remove("runningProject").remove("runningType").remove("runningStart");
        }
        JSONArray today = data.optJSONArray("today");
        if (today != null) e.putString("todayKey", todayKey()).putLong("todayDoneMs", doneMs(today));
        e.apply();
    }

    private static long doneMs(JSONArray today) {
        long midnight = startOfToday();
        String key = todayKey();
        long sum = 0;
        for (int i = 0; i < today.length(); i++) {
            JSONObject r = today.optJSONObject(i);
            if (r == null) continue;
            String start = r.optString("start", "");
            if (start.isEmpty() || "null".equals(start)) {
                if (key.equals(r.optString("date"))) sum += Math.round(r.optDouble("hours", 0) * 3600000);
                continue;
            }
            String end = r.optString("end", "");
            if (end.isEmpty() || "null".equals(end)) continue; // en cours : compté par le chrono
            long a = Math.max(Instant.parse(start).toEpochMilli(), midnight);
            long b = Instant.parse(end).toEpochMilli();
            if (b > a) sum += b - a;
        }
        return sum;
    }
}
