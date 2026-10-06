using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Local acceptance fixture only: no network, credentials, or user application data.
class StageNativeFixture : Form {
    readonly string statePath;
    int clicks, scroll, drags;
    readonly TextBox text = new TextBox();
    readonly Panel scrolling = new Panel();
    Point dragStart;
    bool dragging;

    void SaveState() {
        var state = new { pid = Process.GetCurrentProcess().Id, windowId = Handle.ToInt64().ToString(),
            clicks = clicks, text = text.Text, scroll = scroll, drags = drags };
        var temporary = statePath + ".tmp";
        File.WriteAllText(temporary, new JavaScriptSerializer().Serialize(state));
        if (File.Exists(statePath)) File.Replace(temporary, statePath, null);
        else File.Move(temporary, statePath);
    }

    StageNativeFixture(string path, string title) {
        statePath = path;
        Text = title;
        ClientSize = new Size(640, 480);
        StartPosition = FormStartPosition.CenterScreen;
        var click = new Button { Text = "Click counter", Location = new Point(20,20), Size = new Size(140,40) };
        click.Click += delegate { clicks++; click.Text = "Clicks: " + clicks; SaveState(); };
        text.Location = new Point(20,90); text.Size = new Size(280,30);
        text.TextChanged += delegate { SaveState(); };
        scrolling.Location = new Point(20,150); scrolling.Size = new Size(260,240); scrolling.AutoScroll = true;
        scrolling.Controls.Add(new Label { Text = "Scroll fixture", Location = new Point(0,0), Size = new Size(200,1200), BackColor = Color.LightSteelBlue });
        scrolling.Scroll += delegate { scroll = -scrolling.AutoScrollPosition.Y; SaveState(); };
        scrolling.MouseWheel += delegate { BeginInvoke((Action)(() => { scroll = -scrolling.AutoScrollPosition.Y; SaveState(); })); };
        var drag = new Panel { Location = new Point(350,150), Size = new Size(200,240), BackColor = Color.CornflowerBlue };
        drag.Controls.Add(new Label { Text = "Drag on the blue area", Location = new Point(10,10), AutoSize = true });
        drag.MouseDown += (sender, e) => { dragging = true; dragStart = e.Location; drag.Capture = true; };
        drag.MouseUp += (sender, e) => { if (dragging && Math.Abs(e.X-dragStart.X)+Math.Abs(e.Y-dragStart.Y) > 10) drags++; dragging = false; drag.Capture = false; SaveState(); };
        Controls.AddRange(new Control[] { click, text, scrolling, drag });
        Shown += delegate { SaveState(); };
    }

    [STAThread] static void Main(string[] args) {
        if (args.Length != 2) return;
        Application.EnableVisualStyles();
        Application.Run(new StageNativeFixture(args[0], args[1]));
    }
}
