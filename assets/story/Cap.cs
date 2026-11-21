using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

/**
 * 找「原神」窗口并取它客户区在屏幕上的位置。
 *
 * 为什么不按进程名找：国服官方是 YuanShen.exe，但第三方启动器
 * （芙芙启动器 FufuLauncher 等）里进程名完全不同。
 * 窗口标题「原神」才是稳定的标识。
 */
public class GifaCap
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);

    /** 原神是 Unity 游戏，主窗口类名固定是这个。
     *  只按标题找会抓到「标题里带原神」的浏览器标签/编辑器 —— 实测抓到过。 */
    public const string GameClass = "UnityWndClass";

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);

    /** 枚举顶层窗口标题，供 PowerShell 侧筛选 */
    public static string[] ListTitles()
    {
        List<string> titles = new List<string>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr p)
        {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len <= 0) return true;
            StringBuilder sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            titles.Add(sb.ToString());
            return true;
        }, IntPtr.Zero);
        return titles.ToArray();
    }

    /** 按标题找到可见窗口，返回句柄；找不到返回 IntPtr.Zero
     *
     *  只做 IndexOf 太松：浏览器标签、编辑器标题里只要带「原神」就会被命中，
     *  实测抓到过「# 工作交接文档：GIFA 原神跟跑」这种窗口，
     *  于是「截游戏左上角」变成了「截浏览器左上角」，分数自然全是 0.4x。
     *  所以这里要求：类名必须是 Unity 游戏窗口，或者标题完全就是「原神」。
     */
    public static IntPtr FindByTitle(string title)
    {
        return FindGameWindow(title, GameClass);
    }

    /** 同上，但允许指定期望的窗口类名（测试和特殊客户端可以传别的） */
    public static IntPtr FindGameWindow(string title, string wantedClass)
    {
        IntPtr byClass = IntPtr.Zero;
        IntPtr byExactTitle = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr p)
        {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len <= 0) return true;
            StringBuilder sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            string t = sb.ToString();
            if (t.IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
            // 排除启动器自己：标题里带「启动器」的不是游戏画面
            if (t.IndexOf("启动器", StringComparison.OrdinalIgnoreCase) >= 0) return true;

            // 1) 类名对上 —— 这才是游戏窗口，直接定
            if (ClassOf(hWnd).Equals(wantedClass, StringComparison.OrdinalIgnoreCase))
            {
                byClass = hWnd;
                return false;
            }
            // 2) 退一步：标题完全等于「原神」（有的客户端标题就只有两个字）
            if (byExactTitle == IntPtr.Zero && t.Trim().Equals(title, StringComparison.OrdinalIgnoreCase))
            {
                byExactTitle = hWnd;
            }
            return true;
        }, IntPtr.Zero);
        return byClass != IntPtr.Zero ? byClass : byExactTitle;
    }

    /** 窗口类名（UnityWndClass / Chrome_WidgetWin_1 …） */
    public static string ClassOf(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(256);
        int n = GetClassName(hWnd, sb, sb.Capacity);
        return n > 0 ? sb.ToString() : "";
    }

    /** 窗口所属进程 id；取不到返回 0 */
    public static int PidOf(IntPtr hWnd)
    {
        int pid;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }

    /** 窗口标题；取不到返回空串 */
    public static string TitleOf(IntPtr hWnd)
    {
        int len = GetWindowTextLength(hWnd);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    /** 认窗口身份的字符串：句柄|类名|进程id|标题
     *  日志里必须留下这个 —— 光有「name:原神」看不出截的是哪个窗口，
     *  出了「分数一直 0.4x」根本分不清是画面不对还是模板不对。 */
    public static string Describe(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return "";
        return hWnd.ToInt64() + "|" + ClassOf(hWnd) + "|" + PidOf(hWnd) + "|" + TitleOf(hWnd);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    /** 当前前台窗口句柄。用来判断用户是不是还盯着游戏 */
    public static IntPtr Foreground()
    {
        return GetForegroundWindow();
    }

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    /** 屏幕坐标处最上层的顶层窗口。
     *
     *  为什么不用 GetForegroundWindow 判断「用户是否在看游戏」：
     *  那个 API 只认键盘焦点所属的窗口。QQKit、输入法候选框、某些悬浮窗
     *  会占住前台但根本不遮挡游戏画面，于是我们误判成「游戏不在前台」，
     *  识别整个停掉 —— 用户看到的就是「图标明明在，但浮窗不隐藏」。
     *
     *  改成看「识别区域那个点上，最上面的窗口是谁」：只要游戏在那一块
     *  可见，就该继续识别。 */
    public static IntPtr TopWindowAt(int x, int y)
    {
        POINT p = new POINT();
        p.X = x;
        p.Y = y;
        IntPtr h = WindowFromPoint(p);
        if (h == IntPtr.Zero) return IntPtr.Zero;
        // GA_ROOT = 2：拿到顶层窗口，而不是里面的子控件
        IntPtr root = GetAncestor(h, 2);
        return root != IntPtr.Zero ? root : h;
    }

    public static int[] ClientRectOnScreen(IntPtr hWnd)
    {
        RECT r;
        if (!GetClientRect(hWnd, out r)) return null;
        POINT p = new POINT();
        p.X = 0;
        p.Y = 0;
        if (!ClientToScreen(hWnd, ref p)) return null;
        return new int[] { p.X, p.Y, r.Right, r.Bottom };
    }
}
