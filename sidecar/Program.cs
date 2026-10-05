// ─────────────────────────────────────────────────────────────────────────────
// LHM Sidecar — Lightweight sensor data provider for PerfMon OBS
//
// Uses LibreHardwareMonitorLib to read CPU/GPU/RAM sensors and outputs
// JSON lines to stdout every ~1 second. The Rust/Tauri parent process
// reads these lines and feeds them into the existing sensor pipeline.
//
// Output format (one JSON object per line):
// {"Children":[...], "Text":"Sensor", "Value":"", "Type":null, "HardwareId":null}
//
// This mirrors the /data.json structure from LHM's built-in web server,
// so the existing Rust parser (lhm.rs) can consume it unchanged.
// ─────────────────────────────────────────────────────────────────────────────

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using LibreHardwareMonitor.Hardware;

namespace LhmSidecar;

// ── Visitor that updates all hardware on traversal ───────────────────────────

public sealed class UpdateVisitor : IVisitor
{
    public void VisitComputer(IComputer computer)
    {
        computer.Traverse(this);
    }

    public void VisitHardware(IHardware hardware)
    {
        hardware.Update();
        foreach (var sub in hardware.SubHardware)
            sub.Accept(this);
    }

    public void VisitSensor(ISensor sensor) { }
    public void VisitParameter(IParameter parameter) { }
}

// ── JSON output node (matches LHM web server /data.json structure) ──────────

public sealed class SensorNode
{
    [JsonPropertyName("Text")]
    public string Text { get; set; } = "";

    [JsonPropertyName("Value")]
    public string Value { get; set; } = "";

    [JsonPropertyName("Type")]
    public string? Type { get; set; }

    [JsonPropertyName("HardwareId")]
    public string? HardwareId { get; set; }

    [JsonPropertyName("Children")]
    public List<SensorNode> Children { get; set; } = new();
}

// ── Source Generated JSON Context for Native AOT / Trimmed builds ────────────

[JsonSerializable(typeof(SensorNode))]
internal partial class SensorNodeContext : JsonSerializerContext
{
}

// ── Main program ─────────────────────────────────────────────────────────────

public static class Program
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false,
        TypeInfoResolver = SensorNodeContext.Default
    };

    public static void Main(string[] args)
    {
        // Signal to the parent process that we've started
        Console.Error.WriteLine("[lhm-sidecar] Initializing LibreHardwareMonitor...");

        var computer = new Computer
        {
            IsCpuEnabled = true,
            IsGpuEnabled = true,
            IsMemoryEnabled = true,
            IsMotherboardEnabled = false,  // Not needed for our overlay
            IsStorageEnabled = false,      // Not needed for our overlay
            IsNetworkEnabled = false,      // Not needed for our overlay
            IsBatteryEnabled = false,
            IsControllerEnabled = false,
        };

        try
        {
            computer.Open();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[lhm-sidecar] Failed to open Computer: {ex.Message}");
            Console.Error.WriteLine("[lhm-sidecar] Make sure to run as Administrator.");
            Environment.Exit(1);
        }

        var visitor = new UpdateVisitor();

        Console.Error.WriteLine("[lhm-sidecar] Sensor polling started.");

        // Main polling loop — runs until parent process closes our stdin/stdout
        while (true)
        {
            try
            {
                // Update all hardware readings
                computer.Accept(visitor);

                // Build the JSON tree
                var root = new SensorNode { Text = "Sensor" };

                foreach (var hardware in computer.Hardware)
                {
                    var hwNode = BuildHardwareNode(hardware);
                    root.Children.Add(hwNode);
                }

                // Write a single JSON line to stdout
                string json = JsonSerializer.Serialize(root, SensorNodeContext.Default.SensorNode);
                Console.WriteLine(json);
                Console.Out.Flush();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[lhm-sidecar] Poll error: {ex.Message}");
            }

            Thread.Sleep(1000);
        }
    }

    /// <summary>
    /// Recursively build a SensorNode tree from an IHardware, including
    /// sub-hardware and sensors grouped by sensor type.
    /// </summary>
    private static SensorNode BuildHardwareNode(IHardware hardware)
    {
        var hwNode = new SensorNode
        {
            Text = hardware.Name,
            HardwareId = hardware.Identifier.ToString(),
        };

        // Group sensors by type (Temperature, Clock, Load, Power, etc.)
        var sensorsByType = new Dictionary<SensorType, List<ISensor>>();
        foreach (var sensor in hardware.Sensors)
        {
            if (!sensorsByType.ContainsKey(sensor.SensorType))
                sensorsByType[sensor.SensorType] = new List<ISensor>();
            sensorsByType[sensor.SensorType].Add(sensor);
        }

        foreach (var (sensorType, sensors) in sensorsByType)
        {
            var typeNode = new SensorNode { Text = sensorType.ToString() };

            foreach (var sensor in sensors)
            {
                var sensorNode = new SensorNode
                {
                    Text = sensor.Name,
                    Value = FormatSensorValue(sensor),
                    Type = sensorType.ToString(),
                };
                typeNode.Children.Add(sensorNode);
            }

            hwNode.Children.Add(typeNode);
        }

        // Recurse into sub-hardware (e.g. individual CPU cores)
        foreach (var sub in hardware.SubHardware)
        {
            hwNode.Children.Add(BuildHardwareNode(sub));
        }

        return hwNode;
    }

    /// <summary>
    /// Format a sensor value to match LHM web server output format.
    /// E.g. "45.0 °C", "3200.0 MHz", "55.0 %"
    /// </summary>
    private static string FormatSensorValue(ISensor sensor)
    {
        if (sensor.Value == null)
            return "- -";

        float val = sensor.Value.Value;

        return sensor.SensorType switch
        {
            SensorType.Temperature => $"{val:F1} °C",
            SensorType.Clock => $"{val:F1} MHz",
            SensorType.Load => $"{val:F1} %",
            SensorType.Power => $"{val:F1} W",
            SensorType.Data => $"{val:F1} GB",
            SensorType.SmallData => $"{val:F1} MB",
            SensorType.Voltage => $"{val:F3} V",
            SensorType.Fan => $"{val:F0} RPM",
            SensorType.Flow => $"{val:F1} L/h",
            SensorType.Factor => $"{val:F3}",
            SensorType.Frequency => $"{val:F1} Hz",
            SensorType.Throughput => $"{val:F1} B/s",
            SensorType.Energy => $"{val:F1} mWh",
            SensorType.Noise => $"{val:F1} dBA",
            SensorType.Current => $"{val:F3} A",
            SensorType.TimeSpan => $"{val:F1} s",
            SensorType.Humidity => $"{val:F1} %",
            _ => $"{val:F1}",
        };
    }
}
