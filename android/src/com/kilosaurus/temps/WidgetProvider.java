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
 * Widget à quatre boutons de type (Autre, Dev, Art, Narration). Un tap envoie une seule requête :
 * lancer, basculer de type, ou mettre en pause. Le chrono affiché est géré par Android
 * (Chronometer), sans réveiller l'app chaque seconde.
 */
public class WidgetProvider extends AppWidgetProvider {
    static final String ACTION_TYPE = "com.kilosaurus.temps.TYPE";
    static final String ACTION_REFRESH = "com.kilosaurus.temps.REFRESH";
    static final String EXTRA_TYPE = "type";

    // Même ordre et mêmes couleurs que la liste du serveur (Core.gs).
    static final String[] TYPES = { "Autre", "Dev", "Art", "Narration" };
    static final int[] BUTTONS = { R.id.type_autre, R.id.type_dev, R.id.type_art, R.id.type_narration };
    static final int[] ON = { R.drawable.type_autre_on, R.drawable.type_dev_on, R.drawable.type_art_on, R.drawable.type_narration_on };
    static final int[] OFF = { R.drawable.type_autre_off, R.drawable.type_dev_off, R.drawable.type_art_off, R.drawable.type_narration_off };

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (ACTION_TYPE.equals(action)) {
            final int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            final String type = intent.getStringExtra(EXTRA_TYPE);
            final PendingResult pending = goAsync();
            new Thread(() -> {
                try { tap(ctx, widgetId, type == null ? TYPES[0] : type); } finally { pending.finish(); }
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

    /**
     * Un tap sur un type : arrêté → lance le projet du widget avec ce type ; un autre type tourne →
     * bascule le compteur en cours vers ce type ; ce type tourne → pause (stop).
     */
    private static void tap(Context ctx, int widgetId, String type) {
        Prefs p = new Prefs(ctx);
        if (p.code().isEmpty()) {
            p.setMessage("Touche le nom du projet pour régler le widget.");
            renderAll(ctx);
            return;
        }
        boolean running = p.isRunning();
        String project = running ? p.runningProject() : p.widgetProject(widgetId);
        if (project.isEmpty()) {
            p.setMessage("Touche le nom du projet pour en choisir un.");
            renderAll(ctx);
            return;
        }
        p.setMessage("Envoi…");
        renderAll(ctx);
        try {
            JSONObject body = new JSONObject().put("code", p.code());
            if (running && type.equals(p.runningType())) {
                body.put("action", "stop");
            } else {
                body.put("action", "start").put("id", UUID.randomUUID().toString()).put("project", project).put("type", type);
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
            v.setTextViewText(R.id.title, p.runningProject() + " · " + p.runningType());
            long base = SystemClock.elapsedRealtime() - (System.currentTimeMillis() - p.runningStart());
            v.setChronometer(R.id.chrono, base, null, true);
            v.setViewVisibility(R.id.chrono, View.VISIBLE);
        } else {
            String project = p.widgetProject(widgetId);
            v.setTextViewText(R.id.title, project.isEmpty() ? "Choisir un projet" : project);
            v.setChronometer(R.id.chrono, SystemClock.elapsedRealtime(), null, false);
            v.setViewVisibility(R.id.chrono, View.GONE);
        }

        String active = p.isRunning() ? p.runningType() : "";
        for (int i = 0; i < TYPES.length; i++) {
            boolean on = TYPES[i].equals(active);
            v.setInt(BUTTONS[i], "setBackgroundResource", on ? ON[i] : OFF[i]);
            v.setTextColor(BUTTONS[i], on ? 0xFFFFFFFF : ctx.getColor(R.color.fg));
            v.setOnClickPendingIntent(BUTTONS[i], typeIntent(ctx, widgetId, i));
        }

        String message = p.message();
        v.setTextViewText(R.id.message, message);
        v.setViewVisibility(R.id.message, message.isEmpty() ? View.GONE : View.VISIBLE);
        v.setOnClickPendingIntent(R.id.message, refreshIntent(ctx, widgetId));

        Intent config = new Intent(ctx, ConfigActivity.class)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        v.setOnClickPendingIntent(R.id.title, PendingIntent.getActivity(ctx, widgetId, config,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        mgr.updateAppWidget(widgetId, v);
    }

    // Codes de requête distincts par widget et par bouton : sinon Android réutilise le même intent.
    private static PendingIntent typeIntent(Context ctx, int widgetId, int index) {
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(ACTION_TYPE)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            .putExtra(EXTRA_TYPE, TYPES[index]);
        return PendingIntent.getBroadcast(ctx, widgetId * 8 + index, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent refreshIntent(Context ctx, int widgetId) {
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(ACTION_REFRESH)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        return PendingIntent.getBroadcast(ctx, widgetId * 8 + 7, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
