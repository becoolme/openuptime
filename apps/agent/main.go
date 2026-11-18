// Command openuptime-agent reports a server's CPU, memory, disk and network metrics to OpenUptime.
//
// It only makes outbound HTTPS requests: nothing listens on the server. Configuration comes from flags or from the
// environment (OPENUPTIME_KEY, OPENUPTIME_ENDPOINT), which is what the install script writes for the systemd unit so
// the key does not show up in the process list.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

var version = "dev"

const (
	minInterval     = 10 * time.Second
	maxInterval     = time.Hour
	defaultInterval = 60 * time.Second
	// a rotated or deleted key is not retried every minute
	invalidKeyBackoff = 5 * time.Minute
)

type config struct {
	key      string
	endpoint string
	interval time.Duration
	ignore   []string
	once     bool
}

func main() {
	cfg := config{}
	var ignore string
	showVersion := false
	flag.StringVar(&cfg.key, "key", os.Getenv("OPENUPTIME_KEY"), "agent key of the project (env OPENUPTIME_KEY)")
	flag.StringVar(&cfg.endpoint, "endpoint", envOr("OPENUPTIME_ENDPOINT", "https://openuptime.app"), "OpenUptime address (env OPENUPTIME_ENDPOINT)")
	flag.DurationVar(&cfg.interval, "interval", defaultInterval, "first report interval; the server's answer takes over")
	flag.StringVar(&ignore, "ignore-interfaces", envOr("OPENUPTIME_IGNORE_INTERFACES", "lo,docker,veth,br-,virbr,cni,flannel,cali,vxlan"),
		"comma-separated interface name prefixes to leave out (env OPENUPTIME_IGNORE_INTERFACES)")
	flag.BoolVar(&cfg.once, "once", false, "collect one report, print it as JSON and exit without sending")
	flag.BoolVar(&showVersion, "version", false, "print the version and exit")
	flag.Parse()
	if showVersion {
		fmt.Println(version)
		return
	}
	cfg.endpoint = strings.TrimRight(cfg.endpoint, "/")
	for _, p := range strings.Split(ignore, ",") {
		if p = strings.TrimSpace(p); p != "" {
			cfg.ignore = append(cfg.ignore, p)
		}
	}
	log.SetFlags(0)
	if err := run(cfg); err != nil {
		log.Fatal(err)
	}
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func run(cfg config) error {
	c, err := newCollector(cfg.ignore)
	if err != nil {
		return err
	}
	if cfg.once {
		time.Sleep(2 * time.Second)
		r, err := c.collect()
		if err != nil {
			return err
		}
		out, _ := json.MarshalIndent(r, "", "  ")
		fmt.Println(string(out))
		return nil
	}
	if !strings.HasPrefix(cfg.key, "oua_") {
		return errors.New("missing or malformed agent key: pass --key oua_… or set OPENUPTIME_KEY")
	}
	client := &http.Client{Timeout: 20 * time.Second}
	interval := clamp(cfg.interval)
	log.Printf("openuptime-agent %s reporting to %s", version, cfg.endpoint)
	// the first report goes out after a short sample so the server shows up right away
	wait := 5 * time.Second
	for {
		time.Sleep(wait)
		r, err := c.collect()
		if err != nil {
			log.Printf("collect: %v", err)
			wait = interval
			continue
		}
		next, err := send(client, cfg, r)
		switch {
		case errors.Is(err, errInvalidKey):
			log.Printf("the agent key was rejected (rotated or deleted?); trying again in %s", invalidKeyBackoff)
			wait = invalidKeyBackoff
		case err != nil:
			log.Printf("report: %v", err)
			wait = interval
		default:
			if next > 0 {
				interval = clamp(next)
			}
			wait = interval
		}
	}
}

func clamp(d time.Duration) time.Duration {
	if d < minInterval {
		return minInterval
	}
	if d > maxInterval {
		return maxInterval
	}
	return d
}

var errInvalidKey = errors.New("invalid agent key")

func send(client *http.Client, cfg config, r *report) (time.Duration, error) {
	body, err := json.Marshal(r)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequest(http.MethodPost, cfg.endpoint+"/api/agent/report", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "openuptime-agent/"+version)
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode == http.StatusUnauthorized {
		return 0, errInvalidKey
	}
	if res.StatusCode/100 != 2 {
		return 0, fmt.Errorf("HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(data)))
	}
	var ack struct {
		Interval int `json:"interval"`
	}
	_ = json.Unmarshal(data, &ack)
	return time.Duration(ack.Interval) * time.Second, nil
}
