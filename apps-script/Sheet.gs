/**
 * Accès à la Sheet : implémente le store dont Core.gs a besoin.
 *
 * Onglet de projet = tout onglet dont le nom ne commence pas par « _ ». Les colonnes sont fixes
 * (voir COLUMNS) et ne contiennent aucune formule : on peut écrire partout.
 */
var COLUMNS = ['id', 'person', 'date', 'start', 'end', 'hours', 'note', 'source', 'created', 'corrected', 'touched'];
var CONFIG_SHEET = '_Config';
var CORRECTIONS_SHEET = '_Corrections';
var TEMPLATE_SHEET = '_Modèle';

function SheetStore(ss) {
  this.ss = ss;
  this.cfg = null;
  this.rowsCache = null;
}

SheetStore.prototype.config = function () {
  if (this.cfg) return this.cfg;
  var values = this.ss.getSheetByName(CONFIG_SHEET).getDataRange().getValues();
  var persons = [];
  var params = {};
  for (var i = 1; i < values.length; i++) {
    var person = String(values[i][0] || '').trim();
    if (person) persons.push(person);
    var key = String(values[i][2] || '').trim();
    if (key) params[key] = values[i][3];
  }
  this.cfg = {
    persons: persons,
    threshold: Number(params['Seuil oubli (h)']) || 8,
    studio: String(params['Onglet studio'] || 'Studio'),
    visible: Number(params['Boutons visibles']) || 4,
  };
  return this.cfg;
};

SheetStore.prototype.sheetNames = function () {
  return this.ss.getSheets().map(function (s) { return s.getName(); });
};

SheetStore.prototype.projects = function () {
  return this.sheetNames().filter(function (n) { return n.charAt(0) !== '_'; });
};

SheetStore.prototype.allRows = function () {
  if (this.rowsCache) return this.rowsCache;
  var out = [];
  var ss = this.ss;
  this.projects().forEach(function (project) {
    var sheet = ss.getSheetByName(project);
    var last = sheet.getLastRow();
    if (last < 2) return;
    var values = sheet.getRange(2, 1, last - 1, COLUMNS.length).getValues();
    values.forEach(function (v, i) {
      if (v[0] === '' && v[1] === '') return;
      var row = { project: project, ref: { project: project, row: i + 2 } };
      COLUMNS.forEach(function (key, c) { row[key] = v[c]; });
      out.push(row);
    });
  });
  this.rowsCache = out;
  return out;
};

// Première ligne dont la colonne B (Personne) est vide.
SheetStore.prototype.firstFreeRow = function (sheet, column) {
  var last = sheet.getLastRow();
  if (last < 2) return 2;
  var values = sheet.getRange(2, column, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) if (values[i][0] === '') return i + 2;
  return last + 1;
};

SheetStore.prototype.insert = function (project, row) {
  var sheet = this.ss.getSheetByName(project);
  var r = this.firstFreeRow(sheet, 2);
  sheet.getRange(r, 1, 1, COLUMNS.length).setValues([COLUMNS.map(function (key) { return row[key]; })]);
  this.rowsCache = null;
};

SheetStore.prototype.update = function (ref, patch) {
  var sheet = this.ss.getSheetByName(ref.project);
  Object.keys(patch).forEach(function (key) {
    sheet.getRange(ref.row, COLUMNS.indexOf(key) + 1).setValue(patch[key]);
  });
  this.rowsCache = null;
};

SheetStore.prototype.addCorrection = function (e) {
  var sheet = this.ss.getSheetByName(CORRECTIONS_SHEET);
  var r = this.firstFreeRow(sheet, 1);
  sheet.getRange(r, 1, 1, 8).setValues([[e.at, e.author, e.source, e.project, e.id, e.field, e.oldValue, e.newValue]]);
};

SheetStore.prototype.createProject = function (name) {
  var ss = this.ss;
  var lastProject = -1;
  ss.getSheets().forEach(function (s, i) { if (s.getName().charAt(0) !== '_') lastProject = i; });
  var copy = ss.getSheetByName(TEMPLATE_SHEET).copyTo(ss).setName(name);
  if (copy.isSheetHidden()) copy.showSheet();
  ss.setActiveSheet(copy);
  ss.moveActiveSheet(lastProject + 2);
  this.rowsCache = null;
};
