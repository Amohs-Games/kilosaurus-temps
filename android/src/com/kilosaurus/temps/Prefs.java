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
 */
final class Prefs {
    private final SharedPreferences sp;

    Prefs(Context ctx) {
        sp = ctx.getSharedPreferences("kt", Context.MODE_PRIVATE);
    }

    String code() { return sp.getString("code", ""); }
    String url() { return sp.getString("url", Api.DEFAULT_URL); }
    String me() { return sp.getString("me", ""); }
    String message() { return sp.getString("message", ""); }

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
            .putLong("localChangeAt", at).apply();
    }

    /** Arrête le compteur affiché, sans attendre le serveur ; sa part d'aujourd'hui rejoint le total du jour. */
    void stopLocal(long at) {
        long from = Math.max(runningStart(), startOfToday());
        long done = todayDoneMs() + Math.max(0, at - from);
        sp.edit().remove("runningProject").remove("runningType").remove("runningStart")
            .putString("todayKey", todayKey()).putLong("todayDoneMs", done).putLong("localChangeAt", at).apply();
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
     * Mémorise l'état renvoyé par l'API. Ignoré tant que des actions du widget attendent : il les
     * précède et effacerait ce que le widget montre.
     */
    void saveStatus(JSONObject data) {
        SharedPreferences.Editor e = sp.edit().putString("me", data.optString("me", ""));
        if (queue().length() > 0 || olderThanLocalChange(data)) { e.apply(); return; }
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

    /**
     * Un état calculé par le serveur avant le dernier tap du widget est périmé : une relecture partie
     * avant un stop, revenue après, rallumerait sinon le compteur (« il se relance tout seul »).
     * L'heure du serveur (`now`) fait foi ; un état sans heure est accepté.
     */
    private boolean olderThanLocalChange(JSONObject data) {
        String now = data.optString("now", "");
        if (now.isEmpty()) return false;
        try {
            return Instant.parse(now).toEpochMilli() < sp.getLong("localChangeAt", 0);
        } catch (RuntimeException ex) {
            return false;
        }
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
