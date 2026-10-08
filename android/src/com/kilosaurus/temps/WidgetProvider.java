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
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Widget lecture / stop. Le téléphone sert à écrire : ▶ relance en type Writing le dernier projet
 * travaillé (celui du dernier compteur, lancé n'importe où : pour en changer, on lance l'autre projet
 * une fois dans l'app), ■ arrête le compteur en cours, d'où qu'il vienne. En pause (lancée depuis l'app), le gros bouton
 * devient ▶ et reprend la tâche d'avant la pause ; un petit ■ à côté arrête le compteur. Le bouton
 * Tâches ouvre l'app sur le panneau des tâches. Tout appui hors des boutons ouvre l'app (connexion,
 * compteur oublié, envoi en attente : tout se règle là).
 *
 * Zéro attente : un tap change l'état affiché (Prefs) et met l'action en file, sans réseau. Un seul
 * envoyeur vide la file derrière, dans l'ordre, chaque action avec l'heure de son tap (tapTime, à
 * l'heure du serveur). Sans réseau, la file attend : nouvel essai toutes les minutes, à chaque tap et
 * à chaque rafraîchissement.
 *
 * Les chronos sont gérés par Android (Chronometer), calés sur le temps écoulé depuis l'allumage du
 * téléphone. Ce repère repart de zéro au redémarrage, et le total « Aujourd'hui » doit repartir de
 * zéro à minuit : le widget se redessine donc au démarrage, à un changement d'heure ou de fuseau, et
 * à minuit (alarme).
 */
public class WidgetProvider extends AppWidgetProvider {
    static final String ACTION_TOGGLE = "com.kilosaurus.temps.TOGGLE";
    static final String ACTION_STOP = "com.kilosaurus.temps.STOP";
    static final String ACTION_REFRESH = "com.kilosaurus.temps.REFRESH";
    static final String ACTION_MIDNIGHT = "com.kilosaurus.temps.MIDNIGHT";
    static final String WIDGET_TYPE = "Writing";
    static final long RETRY_MS = 60000;
    private static final int RETRY_REQUEST = 0x7fff0000;
    private static final int MIDNIGHT_REQUEST = 0x7fff0001;
    private static final int OPEN_APP_REQUEST = 0x7ffe0000;
    private static final int OPEN_TASKS_REQUEST = 0x7ffd0000;

    // LOCK protège la file (lecture-modification-écriture) ; SENDING garantit un seul envoyeur.
    private static final Object LOCK = new Object();
    private static final AtomicBoolean SENDING = new AtomicBoolean(false);

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (ACTION_TOGGLE.equals(action) || ACTION_STOP.equals(action)) {
            toggle(ctx, ACTION_STOP.equals(action));
            background(ctx, () -> send(ctx));
        } else if (ACTION_REFRESH.equals(action) || AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(action) || isClockEvent(action)) {
            renderAll(ctx);
            background(ctx, () -> refresh(ctx));
        } else if (ACTION_MIDNIGHT.equals(action)) {
            renderAll(ctx);
        } else {
            super.onReceive(ctx, intent);
        }
    }

    /** Événements qui décalent les repères des chronos : démarrage, heure ou fuseau changés, mise à jour de l'app. */
    private static boolean isClockEvent(String action) {
        return Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_TIME_CHANGED.equals(action)
            || Intent.ACTION_TIMEZONE_CHANGED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
    }

    private void background(Context ctx, Runnable work) {
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try { work.run(); } finally { pending.finish(); }
        }).start();
    }

    /**
     * Le tap : état affiché changé et action mise en file, tout de suite, sans réseau. Gros bouton :
     * lance, reprend la pause ou arrête ; petit ■ (stopOnly, visible en pause) : arrête.
     */
    private static void toggle(Context ctx, boolean stopOnly) {
        Prefs p = new Prefs(ctx);
        synchronized (LOCK) {
            if (p.code().isEmpty()) {
                p.setMessage("Ouvre l'app pour te connecter.");
            } else {
                long now = p.serverNow();
                JSONObject item = new JSONObject();
                try {
                    if (p.isPaused() && !stopOnly) {
                        // Reprendre : la pause se ferme (sa part rejoint le total du jour), la tâche repart.
                        String project = p.runningProject();
                        String type = p.resumeType();
                        p.stopLocal(now);
                        p.startLocal(project, type, now);
                        item.put("action", "start").put("id", UUID.randomUUID().toString())
                            .put("project", project).put("type", type);
                    } else if (p.isRunning()) {
                        p.stopLocal(now);
                        item.put("action", "stop");
                    } else if (stopOnly) {
                        renderAll(ctx); // déjà arrêté (petit ■ d'un affichage en retard)
                        return;
                    } else {
                        String project = p.lastProject();
                        if (project.isEmpty()) {
                            p.setMessage("Lance un projet une fois dans l'app.");
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
                            // tentative ratée et bloquerait l'adresse du téléphone.
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
                        p.saveStatus(data, p.tapSeq());
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

    // Le compteur de taps est noté avant l'envoi : une réponse partie avant un tap est ignorée à son retour.
    private static void fetchStatus(Prefs p) {
        int seq = p.tapSeq();
        try {
            p.saveStatus(Api.call(p.url(), new JSONObject().put("code", p.code()).put("action", "status")), seq);
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

    // Prochain minuit (heure du téléphone), à quelques minutes près : le total du jour repart de zéro.
    private static void scheduleMidnight(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(ACTION_MIDNIGHT);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, MIDNIGHT_REQUEST, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        long at = LocalDate.now().plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli() + 5000;
        am.setAndAllowWhileIdle(AlarmManager.RTC, at, pi);
    }

    static String describe(Api.ApiException e) {
        if ("unauthorized".equals(e.kind)) return "Code refusé : ouvre l'app pour le corriger.";
        if ("busy".equals(e.kind)) return "Serveur occupé, réessaie.";
        if ("locked".equals(e.kind)) return "Accès bloqué pour une heure (trop de codes refusés).";
        if ("invalid".equals(e.kind) || "server".equals(e.kind)) return "Refusé : " + e.getMessage();
        return e.getMessage();
    }

    static void renderAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        for (int id : mgr.getAppWidgetIds(new ComponentName(ctx, WidgetProvider.class))) render(ctx, mgr, id);
        scheduleMidnight(ctx);
    }

    private static void render(Context ctx, AppWidgetManager mgr, int widgetId) {
        Prefs p = new Prefs(ctx);
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget);
        boolean running = p.isRunning();
        long now = p.serverNow();
        long elapsedNow = SystemClock.elapsedRealtime();

        // Total du jour = temps déjà fait aujourd'hui + part d'aujourd'hui du compteur en cours.
        long today = p.todayDoneMs() + (running ? Math.max(0, now - Math.max(p.runningStart(), Prefs.startOfToday())) : 0);

        // Compteur en cours : chronos d'Android (ils avancent sans réveiller l'app). À l'arrêt : textes
        // fixes, car un chrono arrêté redessiné par le lanceur repartirait de son dernier affichage.
        v.setViewVisibility(R.id.chrono, running ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.chrono_idle, running ? View.GONE : View.VISIBLE);
        // En pause : le chrono compte la pause, le gros bouton reprend (▶ vert), le petit ■ arrête.
        boolean paused = p.isPaused();
        v.setViewVisibility(R.id.stop_small, paused ? View.VISIBLE : View.GONE);
        if (running) {
            v.setTextViewText(R.id.title, paused ? "⏸ En pause · " + p.runningProject() : p.runningProject() + " · " + p.runningType());
            v.setChronometer(R.id.chrono, elapsedNow - (now - p.runningStart()), null, true);
            v.setChronometer(R.id.today, elapsedNow - today, "Aujourd'hui %s", true);
            v.setTextViewText(R.id.button, paused ? "▶" : "■");
            v.setInt(R.id.button, "setBackgroundResource", paused ? R.drawable.btn_play : R.drawable.btn_stop);
        } else {
            String project = p.lastProject();
            v.setTextViewText(R.id.title, project.isEmpty() ? "Kilosaurus Temps" : project + " · " + WIDGET_TYPE);
            v.setChronometer(R.id.chrono, elapsedNow, null, false);
            v.setChronometer(R.id.today, elapsedNow, null, false);
            v.setTextViewText(R.id.chrono_idle, "00:00");
            v.setTextViewText(R.id.today_idle, "Aujourd'hui " + clockText(today));
            v.setTextViewText(R.id.button, "▶");
            v.setInt(R.id.button, "setBackgroundResource", R.drawable.btn_play);
        }

        // Compteur oublié : le message remplace « Aujourd'hui » et ouvre l'app (garde-fou de l'heure de fin).
        boolean forgotten = running && now - p.runningStart() > p.thresholdMs();
        String message = forgotten
            ? "Compteur lancé il y a " + ((now - p.runningStart()) / 3600000L) + " h : touche pour corriger."
            : p.message();
        v.setTextViewText(R.id.message, message);
        v.setViewVisibility(R.id.message, message.isEmpty() ? View.GONE : View.VISIBLE);
        v.setViewVisibility(R.id.today, message.isEmpty() && running ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.today_idle, message.isEmpty() && !running ? View.VISIBLE : View.GONE);

        // Tout appui hors des deux boutons ouvre l'app : le fond, le projet et le message (compteur
        // oublié, code refusé, envoi en attente : l'app le règle, et relance l'envoi à son ouverture).
        PendingIntent openApp = PendingIntent.getActivity(ctx, OPEN_APP_REQUEST + widgetId,
            new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        v.setOnClickPendingIntent(R.id.root, openApp);
        v.setOnClickPendingIntent(R.id.title, openApp);
        v.setOnClickPendingIntent(R.id.message, openApp);
        // Tâches : l'app s'ouvre directement sur le panneau des tâches (écrire la liste du jour).
        // SINGLE_TOP + CLEAR_TOP : une app déjà ouverte reçoit la demande (onNewIntent).
        PendingIntent openTasks = PendingIntent.getActivity(ctx, OPEN_TASKS_REQUEST + widgetId,
            new Intent(ctx, MainActivity.class)
                .putExtra(MainActivity.EXTRA_OPEN_TASKS, true)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        v.setOnClickPendingIntent(R.id.tasks, openTasks);
        v.setOnClickPendingIntent(R.id.button, broadcast(ctx, ACTION_TOGGLE, widgetId));
        v.setOnClickPendingIntent(R.id.stop_small, broadcast(ctx, ACTION_STOP, widgetId));

        mgr.updateAppWidget(widgetId, v);
    }

    /** Durée au format des chronos d'Android : « 12:05 », « 1:02:05 ». */
    static String clockText(long ms) {
        long s = Math.max(0, ms / 1000);
        long h = s / 3600, m = (s % 3600) / 60, sec = s % 60;
        return h > 0 ? String.format(java.util.Locale.ROOT, "%d:%02d:%02d", h, m, sec)
            : String.format(java.util.Locale.ROOT, "%02d:%02d", m, sec);
    }

    // Codes de requête distincts par widget et par action : sinon Android réutilise le même intent.
    private static PendingIntent broadcast(Context ctx, String action, int widgetId) {
        Intent i = new Intent(ctx, WidgetProvider.class).setAction(action)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        int requestCode = widgetId * 3 + (ACTION_TOGGLE.equals(action) ? 0 : ACTION_STOP.equals(action) ? 2 : 1);
        return PendingIntent.getBroadcast(ctx, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
