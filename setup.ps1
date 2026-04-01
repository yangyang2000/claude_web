# Claude Web — interactive setup for Windows (PowerShell)
# Run with: powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"

function Prompt-Input($label, $default = "") {
    if ($default) { $hint = " [$default]" } else { $hint = "" }
    $val = Read-Host "${label}${hint}"
    if ($val -eq "") { $val = $default }
    return $val
}

function Prompt-Secret($label) {
    $val = Read-Host $label -AsSecureString
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($val)
    )
}

function Prompt-YN($label, $default = "y") {
    $val = Read-Host "$label [${default}]"
    if ($val -eq "") { $val = $default }
    return $val -match "^[Yy]"
}

Write-Host ""
Write-Host "Claude Web — setup" -ForegroundColor Cyan
Write-Host "-----------------------------------"
Write-Host ""

# ── .env ──────────────────────────────────────────────────────────────────────

$skipEnv = $false
if (Test-Path ".env") {
    Write-Host "A .env file already exists." -ForegroundColor Yellow
    if (-not (Prompt-YN "Overwrite it?")) {
        Write-Host "Keeping existing .env."
        $skipEnv = $true
    }
}

if (-not $skipEnv) {
    Write-Host ""
    Write-Host "Google OAuth credentials" -ForegroundColor White
    Write-Host "Get these from: https://console.cloud.google.com -> APIs & Services -> Credentials" -ForegroundColor DarkGray
    Write-Host ""
    $clientId     = Prompt-Input "Client ID"
    $clientSecret = Prompt-Secret "Client Secret"

    Write-Host ""
    Write-Host "Server URL" -ForegroundColor White
    Write-Host "The public URL of this server - must match the OAuth redirect URI." -ForegroundColor DarkGray
    Write-Host "Use http://localhost:3000 for local development." -ForegroundColor DarkGray
    Write-Host ""
    $baseUrl = Prompt-Input "Base URL" "http://localhost:3000"

    Write-Host ""
    Write-Host "Session secret" -ForegroundColor White
    if (Prompt-YN "Generate one automatically?") {
        $bytes = New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $sessionSecret = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
        Write-Host "Generated." -ForegroundColor DarkGray
    } else {
        $sessionSecret = Prompt-Secret "Session secret"
    }

    Write-Host ""
    Write-Host "Super admin" -ForegroundColor White
    Write-Host "This Google account has permanent admin access and cannot be removed via the UI." -ForegroundColor DarkGray
    Write-Host ""
    $superAdmin = Prompt-Input "Your Google email"

    Write-Host ""
    Write-Host "Claude CLI path" -ForegroundColor White
    Write-Host "Leave blank if 'claude' is already on your PATH." -ForegroundColor DarkGray
    Write-Host "Otherwise enter the full path, e.g. C:\Users\you\AppData\Roaming\npm\claude.cmd" -ForegroundColor DarkGray
    Write-Host ""
    $claudePath = Prompt-Input "CLAUDE_PATH (blank to skip)"

    Write-Host ""
    $port = Prompt-Input "Port" "3000"

    Write-Host ""
    Write-Host "Projects directory" -ForegroundColor White
    Write-Host "Where user project folders are created. Each user gets a subdirectory inside this." -ForegroundColor DarkGray
    Write-Host ""
    $defaultProjectsBase = "$env:USERPROFILE\Documents\Claude_Projects"
    $projectsBase = Prompt-Input "Projects directory" $defaultProjectsBase

    $envContent = @"
GOOGLE_CLIENT_ID=$clientId
GOOGLE_CLIENT_SECRET=$clientSecret
BASE_URL=$baseUrl
SESSION_SECRET=$sessionSecret
SUPER_ADMIN_EMAIL=$superAdmin
PORT=$port
"@
    if ($claudePath) { $envContent += "`nCLAUDE_PATH=$claudePath" }

    Set-Content -Path ".env" -Value $envContent -Encoding UTF8
    Write-Host "✓ .env created" -ForegroundColor Green
}

# ── settings.json ────────────────────────────────────────────────────────────

if ($projectsBase -and $projectsBase -ne $defaultProjectsBase) {
    $writeSettings = $true
    if (Test-Path "settings.json") {
        Write-Host ""
        Write-Host "settings.json already exists." -ForegroundColor Yellow
        $writeSettings = Prompt-YN "Overwrite it?"
    }
    if ($writeSettings) {
        Set-Content -Path "settings.json" -Value "{`"projectsBase`": `"$($projectsBase.Replace('\','\\'))`"}" -Encoding UTF8
        Write-Host "✓ settings.json created" -ForegroundColor Green
    }
}

# ── whitelist.json ────────────────────────────────────────────────────────────

$skipWhitelist = $false
if (Test-Path "whitelist.json") {
    Write-Host ""
    Write-Host "whitelist.json already exists." -ForegroundColor Yellow
    if (-not (Prompt-YN "Overwrite it?")) {
        Write-Host "Keeping existing whitelist.json."
        $skipWhitelist = $true
    }
}

if (-not $skipWhitelist) {
    Write-Host ""
    Write-Host "Allowed users" -ForegroundColor White
    Write-Host "Enter the Google email addresses that should have access, one per line." -ForegroundColor DarkGray
    Write-Host "Press Enter on an empty line when done." -ForegroundColor DarkGray
    Write-Host ""

    $emails = @()
    if ($superAdmin) {
        $emails += $superAdmin
        Write-Host "(pre-filled your super admin email: $superAdmin)" -ForegroundColor DarkGray
    }

    while ($true) {
        $email = Prompt-Input "Email (blank to finish)"
        if ($email -eq "") { break }
        $emails += $email
    }

    $json = "[" + (($emails | ForEach-Object { "`"$_`"" }) -join ", ") + "]"
    Set-Content -Path "whitelist.json" -Value $json -Encoding UTF8
    Write-Host "✓ whitelist.json created with $($emails.Count) email(s)" -ForegroundColor Green
}

# ── npm install ───────────────────────────────────────────────────────────────

Write-Host ""
if (-not (Test-Path "node_modules")) {
    Write-Host "Running npm install..."
    npm install
    Write-Host "✓ Dependencies installed" -ForegroundColor Green
} else {
    if (Prompt-YN "node_modules exists. Run npm install anyway?") {
        npm install
        Write-Host "✓ Dependencies installed" -ForegroundColor Green
    }
}

# ── Done ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "Start the server with: " -NoNewline; Write-Host "npm start" -ForegroundColor White
if ($baseUrl) {
    Write-Host "Then open:             " -NoNewline; Write-Host $baseUrl -ForegroundColor White
}
Write-Host ""
if ($baseUrl -and $baseUrl -notmatch "^http://localhost") {
    Write-Host "Don't forget to add the OAuth redirect URI in Google Cloud Console:" -ForegroundColor Yellow
    Write-Host "  $baseUrl/auth/google/callback" -ForegroundColor White
    Write-Host ""
}
