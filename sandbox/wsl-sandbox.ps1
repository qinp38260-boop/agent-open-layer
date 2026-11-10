<#
  WSL2 一次性沙箱：建一个独立发行版跑 agent，用完销毁。
  前置（需管理员一次）：启用 WSL 服务
      sc config LxssManager start= auto
      net start LxssManager
  用法：
      .\wsl-sandbox.ps1 up      # 建
      .\wsl-sandbox.ps1 exec    # 进入
      .\wsl-sandbox.ps1 down    # 销毁（含磁盘）
#>
param([Parameter(Mandatory=$true)][ValidateSet('up','exec','down','status')][string]$Action)
$Distro = 'oag-agent'
$Root   = Join-Path $env:USERPROFILE "oag-wsl"
$Tar    = Join-Path $Root "rootfs.tar"

function Ensure-Dir { if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root | Out-Null } }

switch ($Action) {
  'status' {
    wsl.exe -l -v
  }
  'up' {
    Ensure-Dir
    if (-not (Test-Path $Tar)) {
      Write-Host "缺少 rootfs.tar。请先导出一个干净发行版："
      Write-Host "  wsl --export Ubuntu $Tar"
      exit 1
    }
    wsl.exe --import $Distro $Root $Tar --version 2
    if ($LASTEXITCODE -ne 0) { Write-Host "import 失败：WSL 服务可能未启用"; exit 1 }
    wsl.exe -d $Distro -u root -- bash -lc "apt-get update -qq && apt-get install -y -qq curl git nodejs npm >/dev/null && echo ready"
    Write-Host "沙箱已就绪：wsl -d $Distro"
    Write-Host "注意：宿主 home 不会自动挂载（WSL 默认挂 /mnt/d，务必不要在里面操作真实仓库）"
  }
  'exec' { wsl.exe -d $Distro -- bash -lc "cd /root && exec bash" }
  'down' {
    wsl.exe --terminate $Distro
    wsl.exe --unregister $Distro
    Write-Host "已销毁 $Distro（磁盘目录 $Root 保留，可手动删）"
  }
}
