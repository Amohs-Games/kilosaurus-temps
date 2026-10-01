# Crée les raccourcis « Kilosaurus Temps » (bureau et menu Démarrer) vers la mini-fenêtre, pour la
# relancer à la main. Le lancement au démarrage de Windows, lui, est inscrit par l'app elle-même.
#
#   powershell -ExecutionPolicy Bypass -File desktop\install-shortcuts.ps1
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) { throw "Electron absent : lancez d'abord « npm install » dans $dir." }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')
)
foreach ($folder in $targets) {
  $lnk = $shell.CreateShortcut((Join-Path $folder 'Kilosaurus Temps.lnk'))
  $lnk.TargetPath = $exe
  $lnk.Arguments = '"' + $dir + '"'
  $lnk.WorkingDirectory = $dir
  $lnk.IconLocation = (Join-Path $dir 'icon.ico')
  $lnk.Description = 'Mini-fenêtre Kilosaurus Temps'
  $lnk.Save()
  "Raccourci : " + $lnk.FullName
}
