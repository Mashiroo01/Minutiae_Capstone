using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using libzkfpcsharp;

public static class ZktecoZk9500Capture
{
    private const int ZkOk = 0;
    private const int ParamImageWidth = 1;
    private const int ParamImageHeight = 2;
    private const int DefaultWidth = 300;
    private const int DefaultHeight = 375;

    public static int Main(string[] args)
    {
        string outputPath = "";
        string type = "fingerprint";
        int timeoutMs = 30000;
        bool statusOnly = false;

        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i] ?? "";
            if (arg == "--status")
            {
                statusOnly = true;
            }
            else if (arg == "--output" && i + 1 < args.Length)
            {
                outputPath = args[++i];
            }
            else if (arg == "--type" && i + 1 < args.Length)
            {
                type = args[++i];
            }
            else if ((arg == "--timeout" || arg == "--timeout-ms") && i + 1 < args.Length)
            {
                int parsed;
                if (Int32.TryParse(args[++i], out parsed) && parsed > 0)
                {
                    timeoutMs = parsed;
                }
            }
        }

        IntPtr deviceHandle = IntPtr.Zero;
        try
        {
            int initResult = zkfp2.Init();
            if (initResult != ZkOk)
            {
                WriteError("ZKTeco SDK initialization failed.", initResult);
                return 2;
            }

            int deviceCount = zkfp2.GetDeviceCount();
            if (statusOnly)
            {
                WriteJson("{\"success\":true,\"available\":" + (deviceCount > 0 ? "true" : "false") +
                    ",\"deviceCount\":" + deviceCount +
                    ",\"source\":\"ZKTeco ZK9500\"}");
                return deviceCount > 0 ? 0 : 3;
            }

            if (deviceCount <= 0)
            {
                WriteError("No ZKTeco fingerprint scanner detected.", -1001);
                return 3;
            }

            if (String.IsNullOrWhiteSpace(outputPath))
            {
                WriteError("Missing --output path.", -1002);
                return 4;
            }

            deviceHandle = zkfp2.OpenDevice(0);
            if (deviceHandle == IntPtr.Zero)
            {
                WriteError("Unable to open ZKTeco fingerprint scanner.", -1003);
                return 5;
            }

            int width = GetDeviceIntParameter(deviceHandle, ParamImageWidth, DefaultWidth);
            int height = GetDeviceIntParameter(deviceHandle, ParamImageHeight, DefaultHeight);
            if (width <= 0) width = DefaultWidth;
            if (height <= 0) height = DefaultHeight;

            byte[] imageBuffer = new byte[width * height];
            int lastResult = -1;
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);

            while (DateTime.UtcNow < deadline)
            {
                Array.Clear(imageBuffer, 0, imageBuffer.Length);
                lastResult = zkfp2.AcquireFingerprintImage(deviceHandle, imageBuffer);
                if (lastResult == ZkOk && HasFingerprintPixels(imageBuffer))
                {
                    string imagePath = SaveGrayscaleImage(imageBuffer, width, height, outputPath);
                    WriteJson("{\"success\":true,\"imagePath\":\"" + JsonEscape(imagePath) +
                        "\",\"source\":\"ZKTeco ZK9500\",\"deviceCount\":" + deviceCount +
                        ",\"type\":\"" + JsonEscape(type) +
                        "\",\"format\":\"" + JsonEscape(Path.GetExtension(imagePath).TrimStart('.').ToLowerInvariant()) +
                        "\",\"width\":" + width +
                        ",\"height\":" + height +
                        ",\"captureMode\":\"image-only\"}");
                    return 0;
                }

                Thread.Sleep(150);
            }

            WriteError("Timed out waiting for a ZK9500 fingerprint capture. Place a finger flat on the scanner and try again.", lastResult);
            return 6;
        }
        catch (BadImageFormatException)
        {
            WriteError("ZKTeco SDK DLL architecture mismatch. Use the x86 adapter with the 32-bit ZKTeco DLLs from SysWOW64.", -1004);
            return 7;
        }
        catch (Exception ex)
        {
            WriteError(ex.Message, -9999);
            return 1;
        }
        finally
        {
            if (deviceHandle != IntPtr.Zero)
            {
                try { zkfp2.CloseDevice(deviceHandle); } catch { }
            }
            try { zkfp2.Terminate(); } catch { }
        }
    }

    private static int GetDeviceIntParameter(IntPtr handle, int parameterCode, int fallback)
    {
        byte[] buffer = new byte[4];
        int size = 4;
        int value = fallback;
        int result = zkfp2.GetParameters(handle, parameterCode, buffer, ref size);
        if (result == ZkOk && zkfp2.ByteArray2Int(buffer, ref value))
        {
            return value;
        }
        return fallback;
    }

    private static bool HasFingerprintPixels(byte[] pixels)
    {
        int min = 255;
        int max = 0;
        for (int i = 0; i < pixels.Length; i += 32)
        {
            int value = pixels[i];
            if (value < min) min = value;
            if (value > max) max = value;
        }
        return max - min > 10;
    }

    private static string SaveGrayscaleImage(byte[] pixels, int width, int height, string outputPath)
    {
        string extension = Path.GetExtension(outputPath);
        if (String.Equals(extension, ".raw", StringComparison.OrdinalIgnoreCase))
        {
            return SaveGrayscaleRaw(pixels, outputPath);
        }

        return SaveGrayscaleBmp(pixels, width, height, outputPath);
    }

    private static string SaveGrayscaleRaw(byte[] pixels, string outputPath)
    {
        string actualPath = PrepareWritableOutputPath(outputPath);
        using (FileStream stream = new FileStream(actualPath, FileMode.Create, FileAccess.Write, FileShare.Read))
        {
            stream.Write(pixels, 0, pixels.Length);
        }

        return actualPath;
    }

    private static string SaveGrayscaleBmp(byte[] pixels, int width, int height, string outputPath)
    {
        int rowStride = ((width + 3) / 4) * 4;
        int pixelBytes = rowStride * height;
        int paletteBytes = 256 * 4;
        int fileHeaderBytes = 14;
        int dibHeaderBytes = 40;
        int pixelOffset = fileHeaderBytes + dibHeaderBytes + paletteBytes;
        int fileSize = pixelOffset + pixelBytes;

        string actualPath = PrepareWritableOutputPath(outputPath);

        using (FileStream stream = new FileStream(actualPath, FileMode.Create, FileAccess.Write, FileShare.Read))
        using (BinaryWriter writer = new BinaryWriter(stream))
        {
            writer.Write((byte)'B');
            writer.Write((byte)'M');
            writer.Write(fileSize);
            writer.Write((short)0);
            writer.Write((short)0);
            writer.Write(pixelOffset);

            writer.Write(dibHeaderBytes);
            writer.Write(width);
            writer.Write(height);
            writer.Write((short)1);
            writer.Write((short)8);
            writer.Write(0);
            writer.Write(pixelBytes);
            writer.Write(500 * 39);
            writer.Write(500 * 39);
            writer.Write(256);
            writer.Write(0);

            for (int i = 0; i < 256; i++)
            {
                writer.Write((byte)i);
                writer.Write((byte)i);
                writer.Write((byte)i);
                writer.Write((byte)0);
            }

            byte[] padding = new byte[rowStride - width];
            for (int row = height - 1; row >= 0; row--)
            {
                writer.Write(pixels, row * width, width);
                if (padding.Length > 0)
                {
                    writer.Write(padding);
                }
            }
        }

        return actualPath;
    }

    private static string PrepareWritableOutputPath(string outputPath)
    {
        string directory = Path.GetDirectoryName(Path.GetFullPath(outputPath));
        if (!String.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        try
        {
            using (FileStream stream = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.Read))
            {
            }
            File.Delete(outputPath);
            return outputPath;
        }
        catch (UnauthorizedAccessException)
        {
            return BuildFallbackOutputPath(outputPath);
        }
        catch (IOException)
        {
            return BuildFallbackOutputPath(outputPath);
        }
    }

    private static string BuildFallbackOutputPath(string outputPath)
    {
        string fallbackDirectory = Path.Combine(Path.GetTempPath(), "Minutiae", "scanner");
        Directory.CreateDirectory(fallbackDirectory);

        string fileName = Path.GetFileName(outputPath);
        if (String.IsNullOrWhiteSpace(fileName))
        {
            fileName = "scanner-capture-" + DateTime.UtcNow.Ticks + ".bmp";
        }

        return Path.Combine(fallbackDirectory, fileName);
    }

    private static void WriteError(string message, int code)
    {
        WriteJson("{\"success\":false,\"error\":\"" + JsonEscape(message) + "\",\"code\":" + code + ",\"source\":\"ZKTeco ZK9500\"}");
    }

    private static void WriteJson(string json)
    {
        Console.Out.WriteLine(json);
    }

    private static string JsonEscape(string value)
    {
        if (value == null) return "";
        return value
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\r", "\\r")
            .Replace("\n", "\\n")
            .Replace("\t", "\\t");
    }
}
