//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

type collector struct {
	ignore []string
	prev   sample
	mounts mountWatch
}

// sample holds the counters that only mean something as a difference between two readings.
type sample struct {
	at        time.Time
	cpu       cpuTimes
	diskRead  uint64
	diskWrite uint64
	net       map[string]netCounters
}

func newCollector(ignore []string) (*collector, error) {
	c := &collector{ignore: ignore}
	s, err := c.sample()
	if err != nil {
		return nil, err
	}
	c.prev = s
	return c, nil
}

func (c *collector) ignored(name string) bool {
	for _, p := range c.ignore {
		if p == "lo" && name == "lo" || p != "lo" && strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

func (c *collector) sample() (sample, error) {
	s := sample{at: time.Now()}
	stat, err := os.ReadFile("/proc/stat")
	if err != nil {
		return s, err
	}
	s.cpu = parseCPUTimes(string(stat))
	if b, err := os.ReadFile("/proc/diskstats"); err == nil {
		s.diskRead, s.diskWrite = parseDiskstats(string(b), physicalDisks())
	}
	s.net = map[string]netCounters{}
	if b, err := os.ReadFile("/proc/net/dev"); err == nil {
		for name, n := range parseNetDev(string(b)) {
			if !c.ignored(name) {
				s.net[name] = n
			}
		}
	}
	return s, nil
}

func (c *collector) collect() (*report, error) {
	now, err := c.sample()
	if err != nil {
		return nil, err
	}
	prev := c.prev
	c.prev = now
	secs := now.at.Sub(prev.at).Seconds()
	rate := func(a, b uint64) float64 {
		if secs <= 0 || b < a { // counter reset or wrap
			return 0
		}
		return float64(b-a) / secs
	}

	r := &report{Version: version, MachineID: machineID(), Host: hostDetails()}
	r.Hostname, _ = os.Hostname()
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		mem := parseMeminfo(string(b))
		r.Host.MemTotal, r.Host.SwapTotal = mem.total, mem.swapTotal
		r.Metrics.MemUsed, r.Metrics.MemCached, r.Metrics.SwapUsed = mem.used(), mem.cache(), mem.swapTotal-min(mem.swapFree, mem.swapTotal)
	}
	r.Metrics.CPU = cpuPercent(prev.cpu, now.cpu)
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		r.Metrics.Load1, r.Metrics.Load5, r.Metrics.Load15 = parseLoadavg(string(b))
	}
	r.Metrics.DiskReadBps = rate(prev.diskRead, now.diskRead)
	r.Metrics.DiskWriteBps = rate(prev.diskWrite, now.diskWrite)

	r.Ifaces = []netIface{}
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if c.ignored(ifc.Name) {
			continue
		}
		n := netIface{Name: ifc.Name, MAC: ifc.HardwareAddr.String(), IPv4: []string{}, IPv6: []string{}}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ip, _, err := net.ParseCIDR(a.String())
			if err != nil || ip.IsLinkLocalUnicast() || ip.IsLoopback() {
				continue
			}
			if ip.To4() != nil {
				n.IPv4 = append(n.IPv4, ip.String())
			} else {
				n.IPv6 = append(n.IPv6, ip.String())
			}
		}
		if p, ok := prev.net[ifc.Name]; ok {
			cur := now.net[ifc.Name]
			n.RxBps, n.TxBps = rate(p.rx, cur.rx), rate(p.tx, cur.tx)
		}
		r.Metrics.NetRxBps += n.RxBps
		r.Metrics.NetTxBps += n.TxBps
		r.Ifaces = append(r.Ifaces, n)
	}

	r.Disks = []disk{}
	if b, err := os.ReadFile("/proc/self/mounts"); err == nil {
		for _, m := range parseMounts(string(b)) {
			total, used, ok := c.mounts.statfs(m.Mount)
			if ok && total > 0 {
				m.Total, m.Used = total, used
				r.Disks = append(r.Disks, m)
			}
		}
	}
	return r, nil
}

// mountWatch remembers mounts whose statfs has not come back (a dead NFS server), so each report waits on a hung
// mount once and leaves at most one stuck call behind per mount rather than one per report.
type mountWatch struct {
	mu   sync.Mutex
	busy map[string]bool
}

// statfs gives up after a few seconds so a hung network mount cannot stall the report.
func (w *mountWatch) statfs(path string) (total, used uint64, ok bool) {
	type result struct {
		total, used uint64
		ok          bool
	}
	w.mu.Lock()
	if w.busy[path] {
		w.mu.Unlock()
		return 0, 0, false
	}
	if w.busy == nil {
		w.busy = map[string]bool{}
	}
	w.busy[path] = true
	w.mu.Unlock()
	ch := make(chan result, 1)
	go func() {
		defer func() {
			w.mu.Lock()
			delete(w.busy, path)
			w.mu.Unlock()
		}()
		// a file bind-mounted over another (containers do this for /etc/hosts) is not a disk
		if fi, err := os.Stat(path); err != nil || !fi.IsDir() {
			ch <- result{}
			return
		}
		var st syscall.Statfs_t
		if err := syscall.Statfs(path, &st); err != nil {
			ch <- result{}
			return
		}
		bs := uint64(st.Bsize)
		t := st.Blocks * bs
		// used as df shows it: what is taken, not counting the blocks reserved for root
		ch <- result{t, t - st.Bfree*bs, true}
	}()
	select {
	case r := <-ch:
		return r.total, r.used, r.ok
	case <-time.After(3 * time.Second):
		return 0, 0, false
	}
}

// physicalDisks lists whole block devices, leaving out partitions and stacked devices that would count the same I/O twice.
func physicalDisks() map[string]bool {
	out := map[string]bool{}
	entries, err := os.ReadDir("/sys/block")
	if err != nil {
		return nil
	}
	for _, e := range entries {
		name := e.Name()
		for _, p := range []string{"loop", "ram", "zram", "dm-", "md", "sr", "fd", "nbd"} {
			if strings.HasPrefix(name, p) {
				name = ""
				break
			}
		}
		if name != "" {
			out[name] = true
		}
	}
	return out
}

func machineID() string {
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if b, err := os.ReadFile(p); err == nil {
			if id := strings.TrimSpace(string(b)); len(id) >= 8 {
				return id
			}
		}
	}
	// no machine id (some containers): derive a stable one from the host name
	h, _ := os.Hostname()
	sum := sha256.Sum256([]byte("openuptime:" + h))
	return hex.EncodeToString(sum[:16])
}

func hostDetails() hostInfo {
	h := hostInfo{OS: runtime.GOOS, Arch: runtime.GOARCH, Cores: runtime.NumCPU()}
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		h.Platform, h.PlatformVersion = parseOSRelease(string(b))
	}
	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		h.Kernel = strings.TrimSpace(string(b))
	}
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		h.CPUModel = parseCPUModel(string(b))
	}
	if b, err := os.ReadFile("/proc/stat"); err == nil {
		h.BootTime = parseBootTime(string(b))
	}
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		h.UptimeSec = parseUptime(string(b))
	}
	return h
}
