package com.kilosaurus.temps;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Widget lecture / stop. Le téléphone sert à écrire : ▶ lance le projet du widget en type Writing,
 * ■ arrête le compteur en cours, d'où qu'il vienne.
 *
 * Zéro attente : un tap change l'état affiché (Prefs) et met l'action en file, sans réseau. Un seul
 * envoyeur vide la file derrière, dans l'ordre, chaque action avec l'heure de son tap (tapTime).
 * Sans réseau, la file attend : nouvel essai toutes les minutes, à chaque tap et à chaque
 * rafraîchissement. Les chronos sont gérés par Android (Chronometer), sans réveiller l'app.
 */
public class WidgetProvider extends AppWidgetProvider {
    static final String ACTION_TOGGLE = "com.kilosaurus.temps.TOGGLE";
    static final String ACTION_REFRESH = "com.kilosaurus.temps.REFRESH";
    static final String WIDGET_TYPE = "Writing";
    static final long RETRY_MS = 60000;
    private static final int RETRY_REQUEST = 0x7fff0000;

    // LOCK protège la file (lecture-modification-écriture) ; SENDING garantit un seul envoyeur.
    private static final Object LOCK = new Object();
    private static final AtomicBoolean SENDING = new AtomicBoolean(false);

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (ACTION_TOGGLE.equals(action)) {
            int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            toggle(ctx, widgetId);
            background(ctx, () -> send(ctx));
        } else if (ACTION_REFRESH.equals(action) || AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(action)) {
            renderAll(ctx);
            background(ctx, () -> refresh(ctx));
        } else {
            super.onReceive(ctx, intent);
        }
    }

    private void background(Context ctx, Runnable work) {
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try { work.run(); } finally { pending.finish(); }
        }).start();
    }

    @Override
    public void onDeleted(Context ctx, int[] widgetIds) {
        Prefs p = new Prefs(ctx);
        for (int id : widgetIds) p.forgetWidget(id);
    }

    /** Le tap : état affiché changé et action mise en file, tout de suite, sans réseau. */
    private static void toggle(Context ctx, int widgetId) {
        Prefs p = new Prefs(ctx);
        synchronized (LOCK) {
            if (p.code().isEmpty()) {
                p.setMessage("Touche le nom du projet pour régler le widget.");
            } else {
                long now = System.currentTimeMillis();
                JSONObject item = new JSONObject();
                try {
                    if (p.isRunning()) {
                        p.stopLocal(now);
                        item.put("action", "stop");
                    } else {
                        String project = p.widgetProject(widgetId);
                        if (project.isEmpty()) {
                            p.setMessage("Touche le nom du projet pour en choisir un.");
                            renderAll(ctx);
                            return;
                        }
                        p.startLocal(project, WIDGET_TYPE, now);
                        item.put("action", "start").put("id", UUID.randomUUID().toString())
                            .put("project", project).put("type", WIDGET_TYPE);
                    }
                    item.put("tapTime", Instant.ofEpochMilli(now).toString());
                } catch (JSONException e) {
                    return;
                }
                JSONArray q = p.queue();
                q.put(item);
                p.setQueue(q);
                p.setMessage("");
            }
        }
        renderAll(ctx);
    }

    /**
     * Vide la file, une action à la fois, dans l'ordre. Une action refusée par le serveur est
     * retirée, puis le widget se recale sur l'état du serveur. Un échec de réseau garde la file et
     * programme un nouvel essai.
     */
    static void send(Context ctx) {
        Prefs p = new Prefs(ctx);
        do {
            if (!SENDING.compareAndSet(false, true)) return; // un autre envoyeur s'en charge
            boolean dropped = false;
            try {
                while (true) {
                    JSONObject item;
                    synchronized (LOCK) {
                        JSONArray q = p.queue();
                        if (q.length() == 0) break;
                        item = q.optJSONObject(0);
                    }
                    JSONObject data;
                    try {
                        JSONObject body = item == null ? null : new JSONObject(item.toString()).put("code", p.code());
                        data = body == null ? null : Api.call(p.url(), body);
                    } catch (Api.ApiException e) {
                        if ("invalid".equals(e.kind) || "server".equals(e.kind)) {
                            data = null;
                            dropped = true;
                        } else {
                            // Réseau, serveur occupé ou bloqué, code refusé : la file attend. Un code
                            // refusé n'est pas renvoyé tout seul : chaque essai compterait comme une
                            // tentative ratée et bloquerait l'API (Code.gs).
                            int n = p.queue().length();
                            if ("unauthorized".equals(e.kind)) {
                                p.setMessage(describe(e));
                            } else {
                                p.setMessage("Pas de réseau : " + n + " action(s) en attente, envoi automatique.");
                                scheduleRetry(ctx);
                            }
                            renderAll(ctx);
                            return;
                        }
                    } catch (JSONException e) {
                        data = null;
                        dropped = true;
                    }
                    boolean empty;
                    synchronized (LOCK) {
                        JSONArray q = p.queue();
                        q.remove(0);
                        p.setQueue(q);
                        empty = q.length() == 0;
                    }
                    // File vide : l'état du serveur fait foi (saveStatus l'ignore si un tap est arrivé entre-temps).
                    if (empty && data != null) {
                        p.saveStatus(data);
                        p.setMessage("");
                        renderAll(ctx);
                    }
                }
                if (dropped) {
                    p.setMessage("Une action a été refusée par le serveur : affichage recalé.");
                    fetchStatus(p);
                    renderAll(ctx);
                }
            } finally {
                SENDING.set(false);
            }
        } while (p.queue().length() > 0); // un tap arrivé juste à la fin de la boucle
    }

    /** Rafraîchissement : vide d'abord la file ; sinon relit l'état du serveur (compteur lancé ailleurs). */
    static void refresh(Context ctx) {
        Prefs p = new Prefs(ctx);
        if (p.code().isEmpty()) return;
        if (p.queue().length() > 0) { send(ctx); return; }
        try {
            fetchStatus(p);
            p.setMessage("");
        } catch (RuntimeException e) {
            // fetchStatus ne lève rien de prévu ; une erreur imprévue ne doit pas tuer le widget.
        }
        renderAll(ctx);
    }

    private static void fetchStatus(Prefs p) {
        try {
            p.saveStatus(Api.call(p.url(), new JSONObject().put("code", p.code()).put("action", "status")));
        } catch (Api.ApiException e) {
            // Une mise à jour sans réseau n'est pas une erreur à afficher.
            if (!"network".equals(e.kind) && !"timeout".equals(e.kind)) p.setMessage(describe(e));
        } catch (JSONException e) {
            p.setMessage("Erreur interne : " + e.getMessage());
        }
    }

    private static void scheduleRetry(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(ACTION_REFRESH);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, RETRY_REQUEST, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + RETRY_MS, pi);
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
        boolean running = p.isRunning();
        long now = System.currentTimeMillis();
        long elapsedNow = SystemClock.elapsedRealtime();

        // Total du jour = temps déjà fait aujourd'hui + part d'aujourd'hui du compteur en cours.
        long today = p.todayDoneMs() + (running ? Math.max(0, now - Math.max(p.runningStart(), Prefs.startOfToday())) : 0);
        v.setChronometer(R.id.today, elapsedNow - today, "Aujourd'hui %s", running);

        if (running) {
            v.setTextViewText(R.id.title, p.runningProject() + " · " + p.runningType());
            v.setChronometer(R.id.chrono, elapsedNow - (now - p.runningStart()), null, true);
            v.setTextViewText(R.id.button, "■");
            v.setInt(R.id.button, "setBackgroundResource", R.drawable.btn_stop);
        } else {
            String project = p.widgetProject(widgetId);
            v.setTextViewText(R.id.title, project.isEmpty() ? "Choisir un projet" : project + " · " + WIDGET_TYPE);
            v.setChronometer(R.id.chrono, elapsedNow, null, false);
            v.setTextViewText(R.id.button, "▶");
            v.setInt(R.id.button, "setBackgroundResource", R.drawable.btn_play);
        }

        String message = p.message();
        v.setTextViewText(R.id.message, message);
        v.setViewVisibility(R.id.message, message.isEmpty() ? View.GONE : View.VISIBLE);
        v.setViewVisibility(R.id.today, message.isEmpty() ? View.VISIBLE : View.GONE);

        v.setOnClickPendingIntent(R.id.button, broadcast(ctx, ACTION_TOGGLE, widgetId));
        v.setOnClickPendingIntent(R.id.message, broadcast(ctx, ACTION_REFRESH, widgetId));
        Intent config = new Intent(ctx, ConfigActivity.class)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        v.setOnClickPendingIntent(R.id.title, PendingIntent.getActivity(ctx, widgetId, config,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        mgr.updateAppWidget(widgetId, v);
    }

    // Codes de requête distincts par widget et par action : sinon Android réutilise le même intent.
    private static PendingIntent broadcast(Context ctx, String action, int widgetId) {
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(action)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        int requestCode = widgetId * 2 + (ACTION_TOGGLE.equals(action) ? 0 : 1);
        return PendingIntent.getBroadcast(ctx, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
