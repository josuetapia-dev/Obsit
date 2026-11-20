# Obsi-boty "guardia" (standby): a tiny listener that waits for "Obsi, a trabajar" or "Oye Obsi"
# and then opens Obsi-boty. Uses the speech recognizer built into Windows (about 110 MB of RAM),
# so Electron does not need to run while Obsi-boty is hidden.
#
# Windows here only has an English recognizer, so the Spanish phrases are written as an English
# speaker would pronounce them ("obsee a trabaha", "oh yay obsee"). Tested with Spanish voices.
#
# Usage: powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File guardia.ps1 [-Test <file.wav>]

param([string]$Test, [int]$WakeAfter = 0)   # -WakeAfter N: debug, act as if it heard the phrase after N seconds

Add-Type -AssemblyName System.Speech, System.Windows.Forms, System.Drawing

$app = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$electron = Join-Path $app 'node_modules\electron\dist\electron.exe'
$minConfidence = 0.6

# only one guardian at a time
$mutex = New-Object System.Threading.Mutex($false, 'Local\ObsiBotyGuardia')
if (-not $Test -and -not $mutex.WaitOne(0)) { exit }

$en = [Globalization.CultureInfo]'en-US'
$phrases = @(
  'oh yay obsee', 'oye obsee', 'hey obsee',                                        # "Oye Obsi"
  'obsee a trabaha', 'obsee ah trabahar', 'obsee a tra ba har', 'opsee ah trabajar' # "Obsi, a trabajar"
)
$recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine $en
$choices = New-Object System.Speech.Recognition.Choices
$choices.Add([string[]]$phrases)
$builder = New-Object System.Speech.Recognition.GrammarBuilder
$builder.Culture = $en
$builder.Append($choices)
$recognizer.LoadGrammar((New-Object System.Speech.Recognition.Grammar $builder))

# test mode: recognize a wav file and print the result
if ($Test) {
  $recognizer.SetInputToWaveFile($Test)
  $res = $recognizer.Recognize()
  if ($res -and $res.Confidence -ge $minConfidence) { "WAKE '$($res.Text)' $([math]::Round($res.Confidence, 2))" } else { 'NADA' }
  $recognizer.Dispose(); exit
}

$recognizer.SetInputToDefaultAudioDevice()

# tray icon next to the clock, so you always know it's listening and can turn it off
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = New-Object System.Drawing.Icon (Join-Path $app 'assets\obsi-boty.ico')
$tray.Text = 'Obsi-boty: di "Obsi, a trabajar"'
$script:action = $null
$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add('Aparecer', $null, { $script:action = 'wake' })
[void]$menu.Items.Add('Dejar de escuchar (salir)', $null, { $script:action = 'quit' })
$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { $script:action = 'wake' } })
$tray.Visible = $true

# speech events are queued and handled on this thread (avoids PowerShell's runspace-per-thread problem)
Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognized -SourceIdentifier ObsiHeard | Out-Null
$recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

$started = Get-Date
while (-not $script:action) {
  [System.Windows.Forms.Application]::DoEvents()
  if ($WakeAfter -gt 0 -and ((Get-Date) - $started).TotalSeconds -ge $WakeAfter) { $script:action = 'wake' }
  foreach ($ev in @(Get-Event -SourceIdentifier ObsiHeard -ErrorAction SilentlyContinue)) {
    if ($ev.SourceEventArgs.Result.Confidence -ge $minConfidence) { $script:action = 'wake' }
    Remove-Event -EventIdentifier $ev.EventIdentifier
  }
  Start-Sleep -Milliseconds 150
}

$recognizer.RecognizeAsyncCancel()
Unregister-Event -SourceIdentifier ObsiHeard
$recognizer.Dispose()
$tray.Visible = $false
$tray.Dispose()
$mutex.ReleaseMutex()

if ($script:action -eq 'wake' -and (Test-Path $electron)) {
  Start-Process -FilePath $electron -ArgumentList "`"$app`"", '--despertar' -WorkingDirectory $app
}
