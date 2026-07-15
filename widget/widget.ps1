# andy2_crawler status widget
#
# Tiny always-on-top desktop card (top-right of screen) showing live crawler status:
#   Agent   - PC agent online/offline + heartbeat age
#   Crawl   - hourly schedule on/off + countdown to next run (amber while running)
#   Feeds   - news/EDGAR pull cadence + last pull age + new snapshots stored
#   Scanner - alpha-scan alerts in last 24h + total posts scanned
#
# Data: GET <backend>/api/crawler/agent/status every 30s (same endpoint crawler_status
# uses), auth via the ingest key in backend.local.json. No local agent changes needed.
#
# Controls: drag anywhere to move - "minus" collapses to a small pill (click pill to
# expand) - "x" closes. Position + collapsed state persist in widget-state.json.
# Started hidden at logon by scripts/start-agent.vbs -> widget/start-widget.vbs.

$ErrorActionPreference = 'Stop'

# single instance
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'andy2_crawler_widget', [ref]$created)
if (-not $created) { exit }

$LOG = Join-Path $PSScriptRoot 'widget.log'
# keep the previous session's tail so an unexplained death isn't wiped by the next start
$prevLog = if (Test-Path $LOG) { @(Get-Content $LOG -Tail 100) } else { @() }
Set-Content -Path $LOG -Value ($prevLog + "[$([datetime]::Now.ToString('s'))] widget starting (pid=$PID)")

try {

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Net.Http

$ROOT = Split-Path -Parent $PSScriptRoot
$STATE_PATH = Join-Path $PSScriptRoot 'widget-state.json'
$POLL_SECONDS = 30
$DOT = [string][char]0xB7   # middle dot separator

# ── backend config (same sources the agent uses) ─────────────────────────────
$cfg = Get-Content (Join-Path $ROOT 'crawler.config.json') -Raw | ConvertFrom-Json
$baseUrl = $env:CRAWLER_BACKEND_BASEURL
if (-not $baseUrl) { $baseUrl = $cfg.backend.baseUrl }
$key = $env:CRAWLER_INGEST_KEY
if (-not $key) { $key = (Get-Content (Join-Path $ROOT 'backend.local.json') -Raw | ConvertFrom-Json).ingestKey }
if (-not $key) { throw 'no ingest key (backend.local.json / CRAWLER_INGEST_KEY)' }
$URL = $baseUrl.TrimEnd('/') + '/api/crawler/agent/status'
# written by the agent on every state change; read locally each second so idle->crawling
# flips show instantly instead of after the next 30s backend poll
$LOCAL_STATUS = Join-Path $ROOT 'data\agent-status.json'

$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(55)   # Render free tier cold starts are slow
$http.DefaultRequestHeaders.Add('x-crawler-key', $key)

# ── UI ───────────────────────────────────────────────────────────────────────
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Crawler" Width="344" SizeToContent="Height"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize" ShowActivated="False">
  <Grid>
    <Border x:Name="Card" CornerRadius="14" Background="#CC12161E" BorderBrush="#26FFFFFF" BorderThickness="1" Padding="13,10,13,9">
      <StackPanel>
        <Grid Margin="1,0,0,7">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <TextBlock Grid.Column="0" Text="andy2_crawler" FontFamily="Segoe UI" FontSize="17" FontWeight="SemiBold" Foreground="#7B8794" VerticalAlignment="Center"/>
          <TextBlock Grid.Column="1" x:Name="BtnMin" Text="&#x2013;" FontFamily="Segoe UI" FontSize="21" Foreground="#8A94A3" Cursor="Hand" Padding="6,0" Margin="0,-7,4,0" ToolTip="Collapse to a dot"/>
          <TextBlock Grid.Column="2" x:Name="BtnClose" Text="&#x2715;" FontFamily="Segoe UI" FontSize="15" Foreground="#8A94A3" Cursor="Hand" Padding="6,0" Margin="0,-1,-4,0" ToolTip="Close widget"/>
        </Grid>

        <Grid x:Name="RowAgent" Margin="0,3,0,3" Background="Transparent">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/>
          </Grid.ColumnDefinitions>
          <Ellipse x:Name="DotAgent" Grid.Column="0" Width="8" Height="8" Fill="#6B7280" Margin="0,1,8,0" VerticalAlignment="Center"/>
          <TextBlock Grid.Column="1" Text="Agent" FontFamily="Segoe UI" FontSize="17" FontWeight="SemiBold" Foreground="#E7ECF2" VerticalAlignment="Center"/>
          <TextBlock x:Name="DetAgent" Grid.Column="2" Text="..." FontFamily="Segoe UI" FontSize="17" Foreground="#96A0B0" HorizontalAlignment="Right" VerticalAlignment="Center" Margin="8,0,0,0" TextTrimming="CharacterEllipsis"/>
        </Grid>

        <Grid x:Name="RowCrawl" Margin="0,3,0,3" Background="Transparent">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/>
          </Grid.ColumnDefinitions>
          <Ellipse x:Name="DotCrawl" Grid.Column="0" Width="8" Height="8" Fill="#6B7280" Margin="0,1,8,0" VerticalAlignment="Center"/>
          <TextBlock Grid.Column="1" Text="Crawl" FontFamily="Segoe UI" FontSize="17" FontWeight="SemiBold" Foreground="#E7ECF2" VerticalAlignment="Center"/>
          <TextBlock x:Name="DetCrawl" Grid.Column="2" Text="..." FontFamily="Segoe UI" FontSize="17" Foreground="#96A0B0" HorizontalAlignment="Right" VerticalAlignment="Center" Margin="8,0,0,0" TextTrimming="CharacterEllipsis"/>
        </Grid>

        <Grid x:Name="RowFeeds" Margin="0,3,0,3" Background="Transparent">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/>
          </Grid.ColumnDefinitions>
          <Ellipse x:Name="DotFeeds" Grid.Column="0" Width="8" Height="8" Fill="#6B7280" Margin="0,1,8,0" VerticalAlignment="Center"/>
          <TextBlock Grid.Column="1" Text="Feeds" FontFamily="Segoe UI" FontSize="17" FontWeight="SemiBold" Foreground="#E7ECF2" VerticalAlignment="Center"/>
          <TextBlock x:Name="DetFeeds" Grid.Column="2" Text="..." FontFamily="Segoe UI" FontSize="17" Foreground="#96A0B0" HorizontalAlignment="Right" VerticalAlignment="Center" Margin="8,0,0,0" TextTrimming="CharacterEllipsis"/>
        </Grid>

        <Grid x:Name="RowScan" Margin="0,3,0,3" Background="Transparent" Cursor="Hand">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/>
          </Grid.ColumnDefinitions>
          <Ellipse x:Name="DotScan" Grid.Column="0" Width="8" Height="8" Fill="#6B7280" Margin="0,1,8,0" VerticalAlignment="Center"/>
          <TextBlock Grid.Column="1" Text="Scanner" FontFamily="Segoe UI" FontSize="17" FontWeight="SemiBold" Foreground="#E7ECF2" VerticalAlignment="Center"/>
          <TextBlock x:Name="DetScan" Grid.Column="2" Text="..." FontFamily="Segoe UI" FontSize="17" Foreground="#96A0B0" HorizontalAlignment="Right" VerticalAlignment="Center" Margin="8,0,0,0" TextTrimming="CharacterEllipsis"/>
        </Grid>

        <TextBlock x:Name="ScanTable" Visibility="Collapsed" FontFamily="Consolas" FontSize="14" Foreground="#8D97A7" Margin="1,4,0,1" Text=""/>

        <TextBlock x:Name="Footer" Text="connecting..." FontFamily="Segoe UI" FontSize="17" Foreground="#5C6672" Margin="1,7,0,0" Cursor="Hand" ToolTip="Click to refresh now"/>
      </StackPanel>
    </Border>

    <Border x:Name="Pill" Visibility="Collapsed" CornerRadius="12" Background="#CC12161E" BorderBrush="#26FFFFFF" BorderThickness="1" Width="24" Height="24" HorizontalAlignment="Right" VerticalAlignment="Top" Cursor="Hand" ToolTip="Crawler status - click to expand">
      <Ellipse x:Name="PillDot" Width="9" Height="9" Fill="#6B7280"/>
    </Border>
  </Grid>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Parse($xaml)
$U = @{}
foreach ($n in 'Card','Pill','PillDot','BtnMin','BtnClose','Footer',
               'RowAgent','DotAgent','DetAgent','RowCrawl','DotCrawl','DetCrawl',
               'RowFeeds','DotFeeds','DetFeeds','RowScan','DotScan','DetScan','ScanTable') {
    $U[$n] = $window.FindName($n)
}

# short site labels for the per-source stats table
$SITE_ABBR = @{
    'x.com' = 'x'; 'reddit.com' = 'reddit'; 'bloomberg.com' = 'bbg'
    'globenewswire.com' = 'gnw'; 'news.google.com' = 'gnews'; 'sec.gov' = 'sec'
}

function Brush([string]$hex) {
    $b = (New-Object System.Windows.Media.BrushConverter).ConvertFromString($hex)
    $b.Freeze(); $b
}
$GREEN = Brush '#4ADE80'; $AMBER = Brush '#FBBF24'; $RED = Brush '#F87171'
$GRAY  = Brush '#6B7280'; $DIMBL = Brush '#7C8DA6'

# ── position + collapsed state ───────────────────────────────────────────────
$script:collapsed = $false
$script:scanOpen = $true   # per-source stats table under the Scanner row (click row to toggle)
$wa = [System.Windows.SystemParameters]::WorkArea
$window.Left = $wa.Right - $window.Width - 12
$window.Top  = $wa.Top + 12
if (Test-Path $STATE_PATH) {
    try {
        $st = Get-Content $STATE_PATH -Raw | ConvertFrom-Json
        if ($null -ne $st.left -and $null -ne $st.top) {
            # clamp inside the work area so a saved position never puts the card off-screen
            $window.Left = [math]::Max($wa.Left, [math]::Min([double]$st.left, $wa.Right - $window.Width - 4))
            $window.Top  = [math]::Max($wa.Top,  [math]::Min([double]$st.top,  $wa.Bottom - 80))
        }
        $script:collapsed = [bool]$st.collapsed
        if ($null -ne $st.scanOpen) { $script:scanOpen = [bool]$st.scanOpen }
    } catch { }
}

function Save-State {
    try {
        @{ left = $window.Left; top = $window.Top; collapsed = $script:collapsed; scanOpen = $script:scanOpen } |
            ConvertTo-Json -Compress | Set-Content -Path $STATE_PATH
    } catch { }
}

function Set-Collapsed([bool]$c) {
    $script:collapsed = $c
    if ($c) { $U.Card.Visibility = 'Collapsed'; $U.Pill.Visibility = 'Visible' }
    else    { $U.Pill.Visibility = 'Collapsed'; $U.Card.Visibility = 'Visible' }
    Save-State
}

# ── formatting helpers ───────────────────────────────────────────────────────
function Parse-Iso($v) {
    if ($null -eq $v) { return $null }
    if ($v -is [datetime]) { return $v.ToUniversalTime() }
    try { ([DateTimeOffset]::Parse([string]$v, [Globalization.CultureInfo]::InvariantCulture)).UtcDateTime } catch { $null }
}
function Rel-Span([TimeSpan]$ts) {
    if ($ts.TotalSeconds -lt 0) { return '0s' }
    if ($ts.TotalSeconds -lt 90) { return ('{0}s' -f [int][math]::Floor($ts.TotalSeconds)) }
    if ($ts.TotalMinutes -lt 90) { return ('{0}m' -f [int][math]::Floor($ts.TotalMinutes)) }
    if ($ts.TotalHours -lt 36)  { return ('{0}h' -f [int][math]::Floor($ts.TotalHours)) }
    ('{0}d' -f [int][math]::Floor($ts.TotalDays))
}
function Rel-Ago([datetime]$now, $then) {
    if ($null -eq $then) { return '?' }
    Rel-Span ($now - $then)
}
function Fmt-K($n) {
    $n = [double]$n
    if ($n -ge 1000000) { return ('{0:0.#}M' -f ($n / 1000000)) }
    if ($n -ge 1000)    { return ('{0:0.#}k' -f ($n / 1000)) }
    [string][int]$n
}
function Fmt-Mins($m) {
    $m = [int][math]::Round([double]$m)
    if ($m -lt 1)  { return '<1m' }
    if ($m -lt 60) { return "${m}m" }
    $h = [math]::Floor($m / 60); $r = $m % 60
    if ($r -eq 0) { return "${h}h" }
    "${h}h ${r}m"
}
function Fmt-Countdown([TimeSpan]$ts) {
    # live ticking countdown: "1h 4m" / "34m 12s" / "45s" / "due"
    if ($ts.TotalSeconds -le 0)  { return 'due' }
    if ($ts.TotalHours -ge 1)    { return ('{0}h {1}m' -f [math]::Floor($ts.TotalHours), $ts.Minutes) }
    if ($ts.TotalMinutes -ge 1)  { return ('{0}m {1}s' -f [math]::Floor($ts.TotalMinutes), $ts.Seconds) }
    ('{0}s' -f [int][math]::Floor($ts.TotalSeconds))
}

# ── polling (async so a slow backend never freezes the UI) ───────────────────
$script:task = $null
$script:data = $null
$script:lastOkAt = $null
$script:lastErr = $null
$script:nextPollAt = [datetime]::UtcNow

function Update-Ui {
    $now = [datetime]::UtcNow
    $d = $script:data
    if ($null -eq $d) {
        $U.Footer.Text = if ($script:lastErr) { "backend unreachable $DOT retrying" } else { 'connecting...' }
        $U.PillDot.Fill = $GRAY
        return
    }

    # local agent status file (sub-second freshness); trusted while < 90s old
    $local = $null
    try {
        if (Test-Path $LOCAL_STATUS) {
            $ls = Get-Content $LOCAL_STATUS -Raw | ConvertFrom-Json
            $lu = Parse-Iso $ls.updatedAt
            if ($lu -and ($now - $lu).TotalSeconds -le 90) { $local = $ls }
        }
    } catch { }

    # Agent
    $online = [bool]$d.agent.online -or ($null -ne $local)
    $seen = if ($local) { Rel-Ago $now (Parse-Iso $local.updatedAt) } else { Rel-Ago $now (Parse-Iso $d.agent.lastSeenAt) }
    $status = if ($local) { [string]$local.status }
              elseif ($d.agent.status) { [string]$d.agent.status } else { 'idle' }
    # "idle" only when NOTHING is going on: no crawl schedule, no feeds pulls, no live
    # scanner loop. Any pipeline on -> "active" (or the specific word while the agent
    # itself is busy crawling).
    # Scanner liveness: `enabled` is the AUTHORITATIVE on/off signal (set explicitly by
    # start/stop scanner, not inferred from a timeout); `nextExpectedAt` is a fallback
    # "overdue" check in case a session died without cleanly reporting stop.
    $scannerEnabled = [bool]$d.alphaScan.enabled
    $scannerNextExpected = Parse-Iso $d.alphaScan.nextExpectedAt
    $scannerStarted = Parse-Iso $d.alphaScan.startedAt
    if ($scannerEnabled -and $scannerStarted -and $scannerNextExpected -and ($scannerNextExpected -lt $scannerStarted)) {
        # nextExpectedAt predating startedAt is leftover from a PREVIOUS run (it's only
        # re-stamped at each cycle's end) - give cycle 1 the same cadence + grace window
        $mins = if ($d.alphaScan.everyMinutes) { [double]$d.alphaScan.everyMinutes } else { 60 }
        $scannerNextExpected = $scannerStarted.AddMinutes($mins + 15)
    }
    $scannerOverdue = $scannerEnabled -and $scannerNextExpected -and ($now -gt $scannerNextExpected)
    $scannerOn = $scannerEnabled -and -not $scannerOverdue
    $sch = $d.schedule
    $fm = $sch.feedsEveryMinutes
    if ($null -eq $fm) { $fm = 15 }
    $pipelinesOn = [bool]$sch.enabled -or ($fm -gt 0) -or $scannerOn
    if ($online) {
        if ($status -ne 'idle') {
            $U.DotAgent.Fill = $AMBER
            $U.DetAgent.Text = $status
        } else {
            $U.DotAgent.Fill = $GREEN
            $U.DetAgent.Text = if ($pipelinesOn) { 'active' } else { 'idle' }
        }
    } else {
        $U.DotAgent.Fill = $RED
        $U.DetAgent.Text = "offline $DOT $seen"
    }
    $U.RowAgent.ToolTip = "PC agent on '$($d.agent.hostname)' $DOT last heartbeat $seen ago$(if ($local) { " $DOT local sync (instant)" }) $DOT active = crawl/feeds/scanner working, idle = all quiet"

    # Crawl (hourly schedule)
    $running = (($null -ne $d.active) -and ($null -ne $d.active.running)) -or ($local -and $local.status -eq 'crawling')
    # newest finished job + leading run of consecutive failures (recentJobs is newest-first)
    $lastDone = $null; $failStreak = 0
    foreach ($j in @($d.recentJobs)) {
        if ($null -eq $j.finishedAt) { continue }
        if ($null -eq $lastDone) { $lastDone = $j }
        if ($j.status -eq 'failed') { $failStreak++ } else { break }
    }
    $crawlFailed = ($null -ne $lastDone) -and ($lastDone.status -eq 'failed')
    if ($running) {
        $U.DotCrawl.Fill = $AMBER; $U.DetCrawl.Text = 'running'
    } elseif ($crawlFailed) {
        $U.DotCrawl.Fill = $RED
        $label = if ($failStreak -gt 1) { "failed x$failStreak" } else { 'failed' }
        $suffix = if ($sch.enabled) {
            $next = Parse-Iso $sch.nextRunAt
            if ($next) { " $DOT retry " + (Fmt-Countdown ($next - $now)) } else { '' }
        } else { " $DOT off" }
        $U.DetCrawl.Text = $label + $suffix
    } elseif (-not $sch.enabled) {
        $U.DotCrawl.Fill = $GRAY; $U.DetCrawl.Text = 'off'
    } else {
        $next = Parse-Iso $sch.nextRunAt
        $U.DotCrawl.Fill = if ($online) { $GREEN } else { $GRAY }
        $U.DetCrawl.Text = if ($next) { Fmt-Countdown ($next - $now) } else { 'on' }
    }
    $crawlTip = "every $($sch.everyHours)h $DOT " + [string]$sch.nextRunNote
    if ($crawlFailed) {
        $crawlTip = "last run FAILED $(Rel-Ago $now (Parse-Iso $lastDone.finishedAt)) ago ($failStreak in a row): $($lastDone.error)`n$crawlTip"
    }
    $U.RowCrawl.ToolTip = $crawlTip

    # Feeds (news + EDGAR pulls) - local file wins (instant pull start/end)
    $f = if ($local -and $local.feeds) { $local.feeds } else { $d.agent.feeds }
    # the agent reports "exit code N" as lastResult when a pull fails (success = "[feeds] ..." lines)
    $feedsFailing = ($null -ne $f) -and $f.lastResult -and ([string]$f.lastResult -like 'exit code*')
    if ($fm -le 0) {
        $U.DotFeeds.Fill = $GRAY; $U.DetFeeds.Text = 'off'
    } elseif ($f -and [bool]$f.pulling) {
        $U.DotFeeds.Fill = $AMBER; $U.DetFeeds.Text = 'pulling...'
    } elseif ($feedsFailing) {
        $U.DotFeeds.Fill = $RED
        $lastPull = Parse-Iso $f.lastPullAt
        $U.DetFeeds.Text = if ($lastPull) { "failing $DOT retry " + (Fmt-Countdown ($lastPull.AddMinutes($fm) - $now)) } else { 'failing' }
    } elseif ($f -and $f.lastPullAt) {
        $lastPull = Parse-Iso $f.lastPullAt
        $U.DotFeeds.Fill = if ($online) { $GREEN } else { $GRAY }
        $U.DetFeeds.Text = Fmt-Countdown ($lastPull.AddMinutes($fm) - $now)
    } else {
        $U.DotFeeds.Fill = $GRAY; $U.DetFeeds.Text = 'no pull yet'
    }
    $tip = "news + EDGAR every ${fm}m"
    if ($f -and $f.lastPullAt) { $tip += " $DOT last pull $(Rel-Ago $now (Parse-Iso $f.lastPullAt)) ago" }
    if ($f -and $f.lastResult) { $tip += "`n" + ([string]$f.lastResult) }
    $U.RowFeeds.ToolTip = $tip

    # Scanner (alpha scan) - `enabled` is set explicitly by start/stop scanner (or a bounded
    # ad-hoc run bracketing itself with on/off) - that's the authoritative on/off signal.
    # `nextExpectedAt` (cadence + grace, stamped every cycle) is only a fallback: enabled
    # but past its expected next-cycle time means the owning session likely died without
    # cleanly reporting stop.
    $a = $d.alphaScan
    $alerts = [int]$a.alertsLast24h
    $lastCycle = Parse-Iso $a.lastCycleAt
    $endedAt = Parse-Iso $a.endedAt
    $U.DotScan.Fill = if ($scannerOverdue) { $AMBER } elseif ($scannerEnabled) { $GREEN } elseif ($lastCycle) { $GRAY } else { $DIMBL }
    $chev = [string][char]$(if ($script:scanOpen) { 0x25BE } else { 0x25B8 })   # small down/right triangle
    $ss = $a.sourceStats
    $aggAlerts = [long]0
    if ($ss -and $ss.perSource) {
        foreach ($prop in $ss.perSource.PSObject.Properties) { $aggAlerts += [long]$prop.Value.alerts }
    }
    $U.DetScan.Text = $chev

    # per-source aggregate table (all-time), toggled by clicking the Scanner row
    if ($ss -and $ss.perSource) {
        $fmt = '{0,-8}{1,9}{2,11}{3,12}'
        $lines = @($fmt -f 'src', 'chars', 'c/v/a', 'saved')
        foreach ($prop in ($ss.perSource.PSObject.Properties | Sort-Object { -[long]$_.Value.chars })) {
            $s = $prop.Value
            $name = if ($SITE_ABBR[$prop.Name]) { $SITE_ABBR[$prop.Name] } else { $prop.Name }
            $saved = if ([long]$s.chars -gt 0) { Fmt-Mins ($s.chars / 1000) } else { '0m' }
            $lines += $fmt -f $name, (Fmt-K $s.chars), "$($s.candidates)/$($s.verified)/$($s.alerts)", $saved
        }
        $U.ScanTable.Text = $lines -join "`n"
        $U.ScanTable.ToolTip = "all-time per source $DOT c/v/a = candidates/verified/alerts $DOT tokens ~ chars/2.4 $DOT click Scanner row to hide"
    }
    $U.ScanTable.Visibility = if ($script:scanOpen) { 'Visible' } else { 'Collapsed' }
    $scanState = if ($scannerOverdue) { "overdue $DOT expected by $(Rel-Ago $now $scannerNextExpected) ago, session likely died" }
                 elseif ($scannerEnabled) { "running every $($a.everyMinutes)m" }
                 elseif ($endedAt) { "off $DOT stopped $(Rel-Ago $now $endedAt) ago" }
                 else { 'off' }
    $U.RowScan.ToolTip = "alpha scan in a Claude session $DOT $scanState $DOT last cycle: $(if ($lastCycle) { (Rel-Ago $now $lastCycle) + ' ago' } else { 'unknown' }) $DOT $(Fmt-K $a.scannedTotal) posts scanned $DOT $aggAlerts alerts all-time, $alerts last 24h (cap $($a.alertCapPer24h)) $DOT click to show/hide per-source stats"

    # Footer: key stats from the latest logged scan cycle (posts/chars/reading-time saved);
    # falls back to poll age until a cycle exists. Pill dot aggregates overall health.
    $age = Rel-Ago $now $script:lastOkAt
    if ($script:lastErr) {
        $U.Footer.Text = "backend unreachable $DOT data $age old"
        $U.PillDot.Fill = $RED
    } else {
        # aggregate scan stats since inception (sums of the per-source cumulative tallies)
        $aggPosts = [long]0; $aggChars = [long]0
        if ($ss -and $ss.perSource) {
            foreach ($prop in $ss.perSource.PSObject.Properties) {
                $aggPosts += [long]$prop.Value.posts
                $aggChars += [long]$prop.Value.chars
            }
        }
        if ($aggChars -gt 0) {
            $U.Footer.Text = "$(Fmt-K $aggPosts) posts $DOT $(Fmt-K $aggChars) chars $DOT $(Fmt-Mins ($aggChars / 1000)) saved"
            $U.Footer.ToolTip = "all-time, across $($ss.cycles) scan cycles $DOT ~$(Fmt-K ([math]::Round($aggChars / 2.4))) tokens $DOT updated $age ago $DOT click to refresh now"
        } else {
            $U.Footer.Text = "updated $age ago"
            $U.Footer.ToolTip = 'Click to refresh now'
        }
        $U.PillDot.Fill = if (-not $online -or $crawlFailed -or $feedsFailing) { $RED } elseif ($running -or $status -ne 'idle') { $AMBER } else { $GREEN }
    }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick({
    try {
        if ($script:task) {
            if ($script:task.IsCompleted) {
                try {
                    $json = $script:task.Result
                    $script:data = $json | ConvertFrom-Json
                    $script:lastOkAt = [datetime]::UtcNow
                    $script:lastErr = $null
                } catch {
                    $script:lastErr = $_.Exception.GetBaseException().Message
                }
                $script:task = $null
                $script:nextPollAt = [datetime]::UtcNow.AddSeconds($POLL_SECONDS)
            }
        } elseif ([datetime]::UtcNow -ge $script:nextPollAt) {
            $script:nextPollAt = [datetime]::UtcNow.AddSeconds($POLL_SECONDS)  # re-armed on completion
            $script:task = $http.GetStringAsync($URL)
        }
        Update-Ui
    } catch {
        Add-Content -Path $LOG -Value "[$([datetime]::Now.ToString('s'))] tick error: $($_.Exception.Message)"
    }
})

# ── interactions ─────────────────────────────────────────────────────────────
$U.Card.Add_MouseLeftButtonDown({
    try { $window.DragMove() } catch { }
    Save-State
})
$U.BtnClose.Add_MouseLeftButtonDown({
    param($s, $e)
    $e.Handled = $true
    Add-Content -Path $LOG -Value "[$([datetime]::Now.ToString('s'))] closed via x button"
    $window.Close()
})
$U.BtnMin.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; Set-Collapsed $true })
$U.Pill.Add_MouseLeftButtonDown({
    param($s, $e)
    $e.Handled = $true
    $before = '{0},{1}' -f $window.Left, $window.Top
    try { $window.DragMove() } catch { }
    if (('{0},{1}' -f $window.Left, $window.Top) -eq $before) { Set-Collapsed $false } else { Save-State }
})
$U.Footer.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; $script:nextPollAt = [datetime]::UtcNow })
$U.RowScan.Add_MouseLeftButtonDown({
    param($s, $e)
    $e.Handled = $true
    $script:scanOpen = -not $script:scanOpen
    $U.ScanTable.Visibility = if ($script:scanOpen) { 'Visible' } else { 'Collapsed' }
    Save-State
})
$window.Add_Closed({
    Save-State
    try { $timer.Stop() } catch { }
    try { $http.Dispose() } catch { }
    try { Add-Content -Path $LOG -Value "[$([datetime]::Now.ToString('s'))] window closed" } catch { }
})

if ($script:collapsed) { Set-Collapsed $true }
$timer.Start()
Add-Content -Path $LOG -Value "[$([datetime]::Now.ToString('s'))] up - polling $URL every ${POLL_SECONDS}s"
$null = $window.ShowDialog()

} catch {
    Add-Content -Path $LOG -Value "[$([datetime]::Now.ToString('s'))] FATAL: $($_.Exception.ToString())"
} finally {
    # a log that ends WITHOUT this line means the process was killed externally
    # (taskkill/Task Manager/logoff) — the script never got to run its exit path
    try { Add-Content -Path $LOG -Value "[$([datetime]::Now.ToString('s'))] exiting (pid=$PID)" } catch { }
    try { $mutex.ReleaseMutex() } catch { }
}
