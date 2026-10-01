package com.kilosaurus.temps;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

/**
 * Widget Start / Stop. Un tap envoie une seule requête : stop si un compteur tourne (quel que soit
 * son projet), sinon start sur le projet du widget. Le chrono affiché est géré par Android
 * (Chronometer), sans réveiller l'app chaque seconde.
 */
public class WidgetProvider extends AppWidgetProvider {
    static final String ACTION_TOGGLE = "com.kilosaurus.temps.TOGGLE";
    static final String ACTION_REFRESH = "com.kilosaurus.temps.REFRESH";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (ACTION_TOGGLE.equals(action)) {
            final int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            final PendingResult pending = goAsync();
            new Thread(() -> {
                try { toggle(ctx, widgetId); } finally { pending.finish(); }
            }).start();
        } else if (ACTION_REFRESH.equals(action) || AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(action)) {
            renderAll(ctx);
            final PendingResult pending = goAsync();
            new Thread(() -> {
                try { refresh(ctx); } finally { pending.finish(); }
            }).start();
        } else {
            super.onReceive(ctx, intent);
        }
    }

    @Override
    public void onDeleted(Context ctx, int[] widgetIds) {
        Prefs p = new Prefs(ctx);
        for (int id : widgetIds) p.forgetWidget(id);
    }

    private static void toggle(Context ctx, int widgetId) {
        Prefs p = new Prefs(ctx);
        if (p.code().isEmpty()) {
            p.setMessage("Touche le nom du projet pour régler le widget.");
            renderAll(ctx);
            return;
        }
        boolean running = p.isRunning();
        String project = p.widgetProject(widgetId);
        if (!running && project.isEmpty()) {
            p.setMessage("Touche le nom du projet pour en choisir un.");
            renderAll(ctx);
            return;
        }
        p.setMessage("Envoi…");
        renderAll(ctx);
        try {
            JSONObject body = new JSONObject().put("code", p.code());
            if (running) {
                body.put("action", "stop");
            } else {
                body.put("action", "start").put("id", UUID.randomUUID().toString()).put("project", project);
            }
            p.saveStatus(Api.call(p.url(), body));
            p.setMessage("");
        } catch (Api.ApiException e) {
            p.setMessage(describe(e));
        } catch (JSONException e) {
            p.setMessage("Erreur interne : " + e.getMessage());
        }
        renderAll(ctx);
    }

    /** Relit l'état depuis le serveur (compteur lancé ailleurs, depuis l'app par exemple). */
    static void refresh(Context ctx) {
        Prefs p = new Prefs(ctx);
        if (p.code().isEmpty()) return;
        try {
            p.saveStatus(Api.call(p.url(), new JSONObject().put("code", p.code()).put("action", "status")));
            p.setMessage("");
        } catch (Api.ApiException e) {
            // Une mise à jour automatique sans réseau n'est pas une erreur à afficher.
            if (!"network".equals(e.kind) && !"timeout".equals(e.kind)) p.setMessage(describe(e));
        } catch (JSONException e) {
            p.setMessage("Erreur interne : " + e.getMessage());
        }
        renderAll(ctx);
    }

    static String describe(Api.ApiException e) {
        if ("unauthorized".equals(e.kind)) return "Code refusé : touche le nom du projet pour le corriger.";
        if ("busy".equals(e.kind)) return "Serveur occupé, réessaie.";
        if ("invalid".equals(e.kind) || "server".equals(e.kind)) return "Refusé : " + e.getMessage();
        return e.getMessage();
    }

    static void renderAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        for (int id : mgr.getAppWidgetIds(new ComponentName(ctx, WidgetProvider.class))) render(ctx, mgr, id);
    }

    private static void render(Context ctx, AppWidgetManager mgr, int widgetId) {
        Prefs p = new Prefs(ctx);
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget);

        if (p.isRunning()) {
            v.setTextViewText(R.id.title, p.runningProject());
            long base = SystemClock.elapsedRealtime() - (System.currentTimeMillis() - p.runningStart());
            v.setChronometer(R.id.chrono, base, null, true);
            v.setViewVisibility(R.id.chrono, View.VISIBLE);
            v.setTextViewText(R.id.button, "STOP");
            v.setInt(R.id.button, "setBackgroundResource", R.drawable.btn_stop);
        } else {
            String project = p.widgetProject(widgetId);
            v.setTextViewText(R.id.title, project.isEmpty() ? "Choisir un projet" : project);
            v.setChronometer(R.id.chrono, SystemClock.elapsedRealtime(), null, false);
            v.setViewVisibility(R.id.chrono, View.GONE);
            v.setTextViewText(R.id.button, "START");
            v.setInt(R.id.button, "setBackgroundResource", R.drawable.btn_start);
        }

        String message = p.message();
        v.setTextViewText(R.id.message, message);
        v.setViewVisibility(R.id.message, message.isEmpty() ? View.GONE : View.VISIBLE);

        v.setOnClickPendingIntent(R.id.button, broadcast(ctx, ACTION_TOGGLE, widgetId));
        v.setOnClickPendingIntent(R.id.message, broadcast(ctx, ACTION_REFRESH, widgetId));
        Intent config = new Intent(ctx, ConfigActivity.class)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        v.setOnClickPendingIntent(R.id.title, PendingIntent.getActivity(ctx, widgetId, config,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        mgr.updateAppWidget(widgetId, v);
    }

    private static PendingIntent broadcast(Context ctx, String action, int widgetId) {
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(action)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        int requestCode = widgetId * 2 + (ACTION_TOGGLE.equals(action) ? 0 : 1);
        return PendingIntent.getBroadcast(ctx, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
