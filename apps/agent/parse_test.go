package main

import (
	"math"
	"testing"
)

func TestCPUPercent(t *testing.T) {
	a := parseCPUTimes("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3 4\n")
	b := parseCPUTimes("cpu  200 0 200 1300 200 0 0 0 0 0\n")
	if a.total != 1000 || a.idle != 800 {
		t.Fatalf("parsed %+v", a)
	}
	// 900 more ticks, 700 of them idle or iowait
	if got := cpuPercent(a, b); math.Abs(got-22.222) > 0.01 {
		t.Fatalf("cpu = %v", got)
	}
	if cpuPercent(b, a) != 0 {
		t.Fatal("a counter going backwards must read as 0")
	}
}

func TestMeminfo(t *testing.T) {
	m := parseMeminfo("MemTotal:       16000 kB\nMemFree:  2000 kB\nMemAvailable:   6000 kB\nBuffers: 500 kB\nCached: 3000 kB\nSReclaimable: 500 kB\nShmem: 1000 kB\nSwapTotal: 4000 kB\nSwapFree: 3000 kB\n")
	if m.used() != 10000*1024 {
		t.Fatalf("used = %d", m.used())
	}
	if m.cache() != 3000*1024 {
		t.Fatalf("cached = %d", m.cache())
	}
	if m.swapTotal != 4000*1024 || m.swapFree != 3000*1024 {
		t.Fatalf("swap = %+v", m)
	}
}

func TestMounts(t *testing.T) {
	got := parseMounts(`/dev/sda1 / ext4 rw,relatime 0 0
proc /proc proc rw 0 0
tmpfs /run tmpfs rw 0 0
/dev/sdb1 /mnt/data\040disk xfs rw 0 0
/dev/sda1 / ext4 rw 0 0
nas:/export /mnt/nas nfs4 rw 0 0
overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0
/dev/loop0 /snap/core/1 squashfs ro 0 0
/dev/sda2 /var/lib/docker btrfs rw 0 0
`)
	want := []string{"/", "/mnt/data disk", "/mnt/nas"}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i, m := range want {
		if got[i].Mount != m {
			t.Fatalf("mount %d = %q, want %q", i, got[i].Mount, m)
		}
	}
	if got[2].FS != "nfs4" || got[2].Device != "nas:/export" {
		t.Fatalf("nfs = %+v", got[2])
	}
}

func TestDiskstatsAndNetDev(t *testing.T) {
	stats := `   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0
   8       1 sda1 100 0 2000 0 50 0 4000 0 0 0 0
   7       0 loop0 1 0 8 0 0 0 0 0 0 0 0`
	r, w := parseDiskstats(stats, map[string]bool{"sda": true})
	if r != 2000*512 || w != 4000*512 {
		t.Fatalf("read %d write %d", r, w)
	}
	n := parseNetDev(`Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0
  eth0: 123456 100 0 0 0 0 0 0 654321 90 0 0 0 0 0 0
`)
	if n["eth0"].rx != 123456 || n["eth0"].tx != 654321 || n["lo"].rx != 500 {
		t.Fatalf("net = %+v", n)
	}
}

func TestHostParsers(t *testing.T) {
	p, v := parseOSRelease("NAME=\"Ubuntu\"\nID=ubuntu\nVERSION_ID=\"24.04\"\n")
	if p != "ubuntu" || v != "24.04" {
		t.Fatalf("os-release = %q %q", p, v)
	}
	if m := parseCPUModel("processor\t: 0\nmodel name\t: AMD EPYC 7B13\n"); m != "AMD EPYC 7B13" {
		t.Fatalf("model = %q", m)
	}
	if m := parseCPUModel("processor\t: 0\nBogoMIPS\t: 50.00\nModel\t: Raspberry Pi 4 Model B Rev 1.4\n"); m != "Raspberry Pi 4 Model B Rev 1.4" {
		t.Fatalf("arm model = %q", m)
	}
	if bt := parseBootTime("cpu 1 2 3 4\nbtime 1700000000\n"); bt != 1700000000 {
		t.Fatalf("btime = %d", bt)
	}
	if a, b, c := parseLoadavg("0.52 0.40 0.31 1/123 4567\n"); a != 0.52 || b != 0.40 || c != 0.31 {
		t.Fatalf("load = %v %v %v", a, b, c)
	}
}
