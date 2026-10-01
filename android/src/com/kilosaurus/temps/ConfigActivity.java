package com.kilosaurus.temps;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Réglage d'un widget : code perso (partagé avec l'app), puis projet associé à ce widget.
 * Ouvert par Android quand on pose le widget, et ensuite par un tap sur le nom du projet.
 */
public class ConfigActivity extends Activity {
    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private Prefs prefs;
    private EditText code;
    private EditText url;
    private TextView info;
    private RadioGroup projects;
    private Button save;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = new Prefs(this);
        widgetId = getIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        // Si on quitte sans enregistrer, Android ne pose pas le widget.
        setResult(RESULT_CANCELED, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(24);
        col.setPadding(pad, pad, pad, pad);

        TextView title = text("Bouton Start / Stop", 22);
        col.addView(title);
        col.addView(text("Ton code perso (le même que dans l’app)", 14));
        code = new EditText(this);
        code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        code.setText(prefs.code());
        col.addView(code);
        col.addView(text("Adresse de l’API", 14));
        url = new EditText(this);
        url.setSingleLine(true);
        url.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        url.setText(prefs.url());
        col.addView(url);

        Button connect = new Button(this);
        connect.setText("Charger mes projets");
        connect.setOnClickListener(v -> load());
        col.addView(connect);

        info = text("", 14);
        col.addView(info);
        projects = new RadioGroup(this);
        col.addView(projects);

        save = new Button(this);
        save.setText("Enregistrer");
        save.setEnabled(false);
        save.setOnClickListener(v -> save());
        col.addView(save);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(col);
        MainActivity.padForSystemBars(scroll);
        setContentView(scroll);

        if (!prefs.code().isEmpty()) load();
    }

    private void load() {
        final String c = code.getText().toString().trim();
        final String u = url.getText().toString().trim();
        if (c.isEmpty()) {
            info.setText("Saisis ton code.");
            return;
        }
        info.setText("Connexion…");
        save.setEnabled(false);
        new Thread(() -> {
            try {
                JSONObject data = Api.call(u, new JSONObject().put("code", c).put("action", "status"));
                prefs.setAccess(c, u);
                prefs.saveStatus(data);
                runOnUiThread(() -> showProjects(data));
            } catch (Api.ApiException e) {
                final String msg = "unauthorized".equals(e.kind) ? "Code inconnu." : e.getMessage();
                runOnUiThread(() -> info.setText(msg));
            } catch (JSONException e) {
                runOnUiThread(() -> info.setText("Erreur interne : " + e.getMessage()));
            }
        }).start();
    }

    private void showProjects(JSONObject data) {
        info.setText("Connecté : " + data.optString("me") + ". Choisis le projet du bouton :");
        projects.removeAllViews();
        JSONArray list = data.optJSONArray("projects");
        String current = prefs.widgetProject(widgetId);
        for (int i = 0; list != null && i < list.length(); i++) {
            RadioButton r = new RadioButton(this);
            String name = list.optString(i);
            r.setText(name);
            r.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
            r.setId(i + 1);
            r.setMinHeight(dp(48));
            projects.addView(r);
            if (name.equals(current) || (current.isEmpty() && i == 0)) r.setChecked(true);
        }
        save.setEnabled(list != null && list.length() > 0);
    }

    private void save() {
        RadioButton picked = findViewById(projects.getCheckedRadioButtonId());
        if (picked == null) {
            info.setText("Choisis un projet.");
            return;
        }
        prefs.setWidgetProject(widgetId, picked.getText().toString());
        prefs.setMessage("");
        WidgetProvider.renderAll(this);
        setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
        finish();
    }

    private TextView text(String s, int sp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setGravity(Gravity.START);
        t.setPadding(0, dp(12), 0, dp(4));
        t.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
