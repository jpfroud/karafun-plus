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
            // 15 s : PowerShell (KaraFun ouvert ?) puis la version qui tourne
            // peuvent prendre plusieurs secondes sur un PC lent.
            if (process == null || (process.WaitForExit(15000) && process.ExitCode != 0))
            {
                // 3 : une autre version tourne deja (start-evening.js).
                string message = process != null && process.ExitCode == 3
                    ? "Une autre version de la file karaok\u00e9 tourne d\u00e9j\u00e0. Sur la page du bar qui s'ouvre, clique \u00ab Arr\u00eater la soir\u00e9e \u00bb, puis relance KaraFun Plus."
                    : "Le d\u00e9marrage a \u00e9chou\u00e9. Lance DEMARRER.bat pour lire le d\u00e9tail de l'erreur.";
                MessageBox.Show(message, "KaraFun Plus", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
        catch (Exception error)
        {
            MessageBox.Show("Impossible de lancer la file karaok\u00e9 : " + error.Message,
                "KaraFun Plus", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
