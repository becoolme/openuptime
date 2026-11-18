package main

import (
	"strconv"
	"strings"
)

// The parsers below read the text of /proc files. They take strings so they can be tested on any system.

type cpuTimes struct{ idle, total uint64 }

func parseCPUTimes(stat string) cpuTimes {
	for _, line := range strings.Split(stat, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 || f[0] != "cpu" {
			continue
		}
		var t cpuTimes
		// user nice system idle iowait irq softirq steal; guest time is already counted in user
		for i, v := range f[1:] {
			if i >= 8 {
				break
			}
			n, _ := strconv.ParseUint(v, 10, 64)
			t.total += n
			if i == 3 || i == 4 {
				t.idle += n
			}
		}
		return t
	}
	return cpuTimes{}
}

func cpuPercent(a, b cpuTimes) float64 {
	if b.total <= a.total || b.idle < a.idle {
		return 0
	}
	busy := float64((b.total-a.total)-(b.idle-a.idle)) / float64(b.total-a.total) * 100
	if busy < 0 {
		return 0
	}
	if busy > 100 {
		return 100
	}
	return busy
}

func parseBootTime(stat string) int64 {
	for _, line := range strings.Split(stat, "\n") {
		if f := strings.Fields(line); len(f) == 2 && f[0] == "btime" {
			n, _ := strconv.ParseInt(f[1], 10, 64)
			return n
		}
	}
	return 0
}

func parseUptime(s string) float64 {
	f := strings.Fields(s)
	if len(f) == 0 {
		return 0
	}
	n, _ := strconv.ParseFloat(f[0], 64)
	return n
}

type meminfo struct{ total, free, available, buffers, cached, reclaimable, shmem, swapTotal, swapFree uint64 }

func parseMeminfo(s string) meminfo {
	var m meminfo
	fields := map[string]*uint64{
		"MemTotal": &m.total, "MemFree": &m.free, "MemAvailable": &m.available, "Buffers": &m.buffers, "Cached": &m.cached,
		"SReclaimable": &m.reclaimable, "Shmem": &m.shmem, "SwapTotal": &m.swapTotal, "SwapFree": &m.swapFree,
	}
	for _, line := range strings.Split(s, "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if p, known := fields[name]; ok && known {
			f := strings.Fields(rest)
			if len(f) > 0 {
				n, _ := strconv.ParseUint(f[0], 10, 64)
				*p = n * 1024 // kB
			}
		}
	}
	return m
}

// used is memory that cannot be handed out without swapping: total minus MemAvailable, as `free` reports it.
func (m meminfo) used() uint64 {
	avail := m.available
	if avail == 0 { // kernels before 3.14
		avail = m.free + m.buffers + m.cached
	}
	if avail > m.total {
		return 0
	}
	return m.total - avail
}

func (m meminfo) cache() uint64 {
	c := m.buffers + m.cached + m.reclaimable
	if c < m.shmem {
		return 0
	}
	return c - m.shmem
}

func parseLoadavg(s string) (float64, float64, float64) {
	f := strings.Fields(s)
	if len(f) < 3 {
		return 0, 0, 0
	}
	a, _ := strconv.ParseFloat(f[0], 64)
	b, _ := strconv.ParseFloat(f[1], 64)
	c, _ := strconv.ParseFloat(f[2], 64)
	return a, b, c
}

// parseDiskstats sums bytes read and written by the given devices (all devices when the set is nil).
func parseDiskstats(s string, devices map[string]bool) (read, written uint64) {
	for _, line := range strings.Split(s, "\n") {
		f := strings.Fields(line)
		if len(f) < 10 || (devices != nil && !devices[f[2]]) {
			continue
		}
		r, _ := strconv.ParseUint(f[5], 10, 64)
		w, _ := strconv.ParseUint(f[9], 10, 64)
		read += r * 512
		written += w * 512
	}
	return
}

type netCounters struct{ rx, tx uint64 }

func parseNetDev(s string) map[string]netCounters {
	out := map[string]netCounters{}
	for _, line := range strings.Split(s, "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(f[0], 10, 64)
		tx, _ := strconv.ParseUint(f[8], 10, 64)
		out[strings.TrimSpace(name)] = netCounters{rx, tx}
	}
	return out
}

// Filesystems that hold data: local disks and network shares. Everything else in /proc/self/mounts is virtual.
var dataFS = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true, "f2fs": true, "jfs": true, "reiserfs": true,
	"vfat": true, "exfat": true, "ntfs": true, "ntfs3": true, "fuseblk": true, "hfsplus": true, "bcachefs": true,
	"nfs": true, "nfs4": true, "cifs": true, "smb3": true, "ceph": true, "glusterfs": true, "fuse.sshfs": true, "9p": true, "virtiofs": true,
}

var skipMountPrefixes = []string{"/proc", "/sys", "/dev", "/run", "/snap", "/var/lib/docker", "/var/lib/containers", "/var/lib/kubelet"}

// parseMounts lists data filesystems, each mount point once. Btrfs subvolumes and bind mounts share a device; the
// server counts a device once in its totals.
func parseMounts(s string) []disk {
	var out []disk
	seen := map[string]bool{}
	for _, line := range strings.Split(s, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || !dataFS[f[2]] {
			continue
		}
		mount := unescapeMount(f[1])
		skip := seen[mount]
		for _, p := range skipMountPrefixes {
			if mount == p || strings.HasPrefix(mount, p+"/") {
				skip = true
			}
		}
		if skip {
			continue
		}
		seen[mount] = true
		out = append(out, disk{Device: unescapeMount(f[0]), Mount: mount, FS: f[2]})
	}
	return out
}

// unescapeMount turns the octal escapes of /proc/self/mounts (\040 for a space) back into characters.
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func parseOSRelease(s string) (platform, version string) {
	vals := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		k, v, ok := strings.Cut(line, "=")
		if ok {
			vals[k] = strings.Trim(v, `"'`)
		}
	}
	return vals["ID"], vals["VERSION_ID"]
}

func parseCPUModel(s string) string {
	for _, key := range []string{"model name", "Model", "Hardware", "cpu model"} {
		for _, line := range strings.Split(s, "\n") {
			k, v, ok := strings.Cut(line, ":")
			if ok && strings.TrimSpace(k) == key {
				if v = strings.TrimSpace(v); v != "" {
					return v
				}
			}
		}
	}
	return ""
}
