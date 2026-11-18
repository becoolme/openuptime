package main

// report is the body of POST /api/agent/report. Byte counts are bytes, rates are bytes per second, cpu is a percentage.
type report struct {
	Version   string     `json:"version"`
	MachineID string     `json:"machineId"`
	Hostname  string     `json:"hostname"`
	Host      hostInfo   `json:"host"`
	Metrics   metrics    `json:"metrics"`
	Disks     []disk     `json:"disks"`
	Ifaces    []netIface `json:"interfaces"`
}

type hostInfo struct {
	OS              string  `json:"os"`
	Platform        string  `json:"platform"`
	PlatformVersion string  `json:"platformVersion"`
	Kernel          string  `json:"kernel"`
	Arch            string  `json:"arch"`
	CPUModel        string  `json:"cpuModel"`
	Cores           int     `json:"cores"`
	MemTotal        uint64  `json:"memTotal"`
	SwapTotal       uint64  `json:"swapTotal"`
	BootTime        int64   `json:"bootTime,omitempty"`
	UptimeSec       float64 `json:"uptimeSec,omitempty"`
}

type metrics struct {
	CPU          float64 `json:"cpu"`
	MemUsed      uint64  `json:"memUsed"`
	MemCached    uint64  `json:"memCached"`
	SwapUsed     uint64  `json:"swapUsed"`
	Load1        float64 `json:"load1"`
	Load5        float64 `json:"load5"`
	Load15       float64 `json:"load15"`
	DiskReadBps  float64 `json:"diskReadBps"`
	DiskWriteBps float64 `json:"diskWriteBps"`
	NetRxBps     float64 `json:"netRxBps"`
	NetTxBps     float64 `json:"netTxBps"`
}

type disk struct {
	Device string `json:"device"`
	Mount  string `json:"mount"`
	FS     string `json:"fs"`
	Total  uint64 `json:"total"`
	Used   uint64 `json:"used"`
}

type netIface struct {
	Name  string   `json:"name"`
	MAC   string   `json:"mac"`
	IPv4  []string `json:"ipv4"`
	IPv6  []string `json:"ipv6"`
	RxBps float64  `json:"rxBps"`
	TxBps float64  `json:"txBps"`
}
