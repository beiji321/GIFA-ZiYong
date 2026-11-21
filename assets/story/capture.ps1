param()

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

Add-Type -Path (Join-Path $PSScriptRoot 'Cap.cs')

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 用码位拼出「原神」，避免脚本文件编码在中文 Windows 上被误读
$needle = [string][char]0x539F + [char]0x795E

function Write-Result([string]$text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

while ($true) {
  $cmd = [Console]::In.ReadLine()
  if ($null -eq $cmd) { break }
  # 命令可以是 "CAP"（整块 ROI）或 "CAP x y w h"（相对整块的比例子区域）
  $parts = $cmd.Trim().Split(' ')
  if ($parts[0] -ne 'CAP') {
    Write-Result 'NONE:bad-cmd'
    continue
  }

  # 先按进程名 YuanShen（官方 exe），找不到再按窗口标题兜底
  # （第三方启动器里进程名可能不同，但标题仍是「原神」）
  $proc = Get-Process -Name YuanShen -ErrorAction SilentlyContinue |
          Where-Object { $_.MainWindowHandle -ne 0 } |
          Select-Object -First 1

  if ($proc) {
    $h = $proc.MainWindowHandle
  } else {
    $h = [GifaCap]::FindByTitle($needle)
  }

  if ($h -eq [IntPtr]::Zero) {
    Write-Result 'NONE:no-window'
    continue
  }

  # 认窗口身份（句柄|类名|进程id|标题）。
  # 为什么非要带上：日志里原来只有写死的 name:"原神"，
  # 一旦分数一直 0.4x，根本分不清「截错了窗口」还是「模板不对」。
  # 本文件必须存成 UTF-8 带 BOM。PowerShell 5.1 在中文 Windows 上会把
  # 没有 BOM 的脚本按 GBK 解读，中文注释的尾字节一旦像 GBK 前导字节，
  # 就会连换行一起吃掉，下一行代码直接变成注释内容（实测丢过整行赋值）。
  $ident = [GifaCap]::Describe($h)

  # 只在前台识别。
  # 用户切到别的窗口（看攻略、聊天）时游戏被挡住，截出来的是别的画面，
  # 继续识别既没意义、又白烧 CPU，还会误判。
  # 用「前台窗口句柄 == 游戏窗口句柄」判断，比按进程名更准确 ——
  # 不用关心游戏是官方 exe 还是第三方启动器。
  # 只看「识别区域那个点上最上层的窗口是不是游戏」。
  #
  # 不能用 GetForegroundWindow：键盘焦点可能落在别处，而画面仍然可见。
  # 但也不能完全不判断 —— 游戏被别的窗口盖住时，GDI 抓到的是**遮挡者的画面**，
  # 拿它去匹配模板会给出一堆 0.4~0.5 的假分数，
  # 表现为「明明在桌面/浏览器上，程序却在识别」。
  #
  # 唯一的例外是我们自己的浮窗：它置顶且经常压在游戏左上角，
  # 属于本程序的窗口时不算遮挡。
  $box = [GifaCap]::ClientRectOnScreen($h)
  if ($null -eq $box) {
    Write-Result ('NONE:no-rect|' + $ident)
    continue
  }
  $probeX = $box[0] + [int]($box[2] / 6)
  $probeY = $box[1] + [int]($box[3] / 16)
  $top = [GifaCap]::TopWindowAt($probeX, $probeY)
  if ($top -ne $h -and $top -ne [IntPtr]::Zero) {
    $topTitle = [string][GifaCap]::TitleOf($top)
    # 自己人的窗口不算遮挡（浮窗标题固定带「跟跑助手」）
    if ($topTitle -notlike '*跟跑助手*') {
      Write-Result ('NONE:obscured|' + $ident + '|' + [string][GifaCap]::Describe($top))
      continue
    }
  }
  $srcX = $box[0]
  $srcY = $box[1]
  $gameW = $box[2]
  $gameH = $box[3]

  if ($gameW -lt 320 -or $gameH -lt 240) {
    Write-Result ('NONE:bad-size|' + $ident)
    continue
  }

  $roiW = [int][math]::Floor($gameW / 3)
  $roiH = [int][math]::Floor($gameH / 8)
  if ($roiW -lt 32 -or $roiH -lt 16) {
    Write-Result ('NONE:bad-roi|' + $ident)
    continue
  }

  # 允许主进程指定更小的识别区域：
  # 图标常年固定在左上角某个位置，每次都抓 1/3×1/8 会把大部分像素浪费在
  # 空白上（匹配耗时和面积成正比）。参数是相对整块 ROI 的比例矩形：
  #   CAP x y w h
  # 不传就退回整块，保持旧行为。
  $ox = 0; $oy = 0
  if ($parts.Count -ge 5) {
    $rx = [double]$parts[1]; $ry = [double]$parts[2]
    $rw2 = [double]$parts[3]; $rh2 = [double]$parts[4]
    if ($rw2 -gt 0 -and $rh2 -gt 0) {
      $ox = [int][math]::Floor($roiW * $rx)
      $oy = [int][math]::Floor($roiH * $ry)
      $newW = [int][math]::Floor($roiW * $rw2)
      $newH = [int][math]::Floor($roiH * $rh2)
      if ($newW -ge 24 -and $newH -ge 12 -and ($ox + $newW) -le $roiW -and ($oy + $newH) -le $roiH) {
        $roiW = $newW
        $roiH = $newH
      } else {
        $ox = 0; $oy = 0
      }
    }
  }

  $bmp = New-Object System.Drawing.Bitmap $roiW, $roiH
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $size = New-Object System.Drawing.Size $roiW, $roiH
  # 子区域的起点要跟着偏；主进程靠回传的 ox/oy 把命中坐标换算回整块
  $gfx.CopyFromScreen(($srcX + $ox), ($srcY + $oy), 0, 0, $size)
  $gfx.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $b64 = [Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose()

  # 字段顺序：几何 | base64 | 偏移与整块尺寸 | 窗口身份
  # 窗口身份里可能含 '|'（标题），必须放最后，主进程才能把剩余部分整体拼回去。
  Write-Result ("{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}|{9}|{10}" -f $srcX, $srcY, $gameW, $gameH, $roiW, $roiH, $b64, $ox, $oy, ("{0}x{1}" -f [int][math]::Floor($gameW / 3), [int][math]::Floor($gameH / 8)), $ident)
}
