using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class KaraFunPlus
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(root, "node", "node.exe");
        string script = Path.Combine(root, "start-evening.js");
        if (!File.Exists(node) || !File.Exists(script))
        {
            MessageBox.Show("Le dossier de l'application est incomplet. D\u00e9compresse tout le ZIP avant de d\u00e9marrer.",
                "KaraFun Plus", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        try
        {
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = node;
            start.Arguments = "\"" + script + "\"";
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            Process process = Process.Start(start);
            if (process == null || (process.WaitForExit(4000) && process.ExitCode != 0))
            {
                MessageBox.Show("Le d\u00e9marrage a \u00e9chou\u00e9. Lance DEMARRER.bat pour lire le d\u00e9tail de l'erreur.",
                    "KaraFun Plus", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
        catch (Exception error)
        {
            MessageBox.Show("Impossible de lancer la file karaok\u00e9 : " + error.Message,
                "KaraFun Plus", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
