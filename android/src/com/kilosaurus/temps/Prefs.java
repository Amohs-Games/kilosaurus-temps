package com.kilosaurus.temps;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.time.Instant;

/**
 * Réglages et dernier état connu, stockés sur le téléphone.
 * Le code et l'URL sont propres à l'appareil ; le projet est propre à chaque widget posé.
 * L'état « compteur en cours » est celui de la personne, partagé par tous ses widgets.
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

    /** État « compteur en cours » tel qu'il est mémorisé, pour le remettre si une requête échoue. */
    static final class Running {
        final String project, type;
        final long start;
        Running(String project, String type, long start) { this.project = project; this.type = type; this.start = start; }
    }

    Running running() {
        return new Running(sp.getString("runningProject", ""), sp.getString("runningType", "Misc"), sp.getLong("runningStart", 0));
    }

    /** Pose l'état affiché avant la réponse du serveur (null = rien en cours), ou remet un état mémorisé. */
    void setRunning(Running r) {
        SharedPreferences.Editor e = sp.edit();
        if (r == null || r.start <= 0) e.remove("runningProject").remove("runningType").remove("runningStart");
        else e.putString("runningProject", r.project).putString("runningType", r.type).putLong("runningStart", r.start);
        e.apply();
    }

    /** Mémorise l'état renvoyé par l'API (champ running de status). */
    void saveStatus(JSONObject data) {
        SharedPreferences.Editor e = sp.edit().putString("me", data.optString("me", ""));
        JSONObject running = data.optJSONObject("running");
        if (running != null) {
            e.putString("runningProject", running.optString("project", ""));
            e.putString("runningType", running.optString("type", "Misc"));
            e.putLong("runningStart", Instant.parse(running.optString("start")).toEpochMilli());
        } else {
            e.remove("runningProject").remove("runningType").remove("runningStart");
        }
        e.apply();
    }
}
