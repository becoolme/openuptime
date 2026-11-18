// Command openuptime-agent reports a server's CPU, memory, disk and network metrics to OpenUptime.
//
// It only makes outbound HTTPS requests: nothing listens on the server. Configuration comes from flags or from the
// environment (OPENUPTIME_KEY, OPENUPTIME_ENDPOINT, OPENUPTIME_NAME, OPENUPTIME_TAGS), which is what the install script writes for the systemd unit so
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
	// name and tags the server gets when it registers; the dashboard owns them afterwards
	name string
	tags []string
}

const (
	maxNameLen = 120
	maxTags    = 20
	maxTagLen  = 32
)

func main() {
	cfg := config{}
	var ignore, tags string
	showVersion := false
	flag.StringVar(&cfg.key, "key", os.Getenv("OPENUPTIME_KEY"), "agent key of the project (env OPENUPTIME_KEY)")
	flag.StringVar(&cfg.endpoint, "endpoint", envOr("OPENUPTIME_ENDPOINT", "https://openuptime.app"), "OpenUptime address (env OPENUPTIME_ENDPOINT)")
	flag.DurationVar(&cfg.interval, "interval", defaultInterval, "first report interval; the server's answer takes over")
	flag.StringVar(&ignore, "ignore-interfaces", envOr("OPENUPTIME_IGNORE_INTERFACES", "lo,docker,veth,br-,virbr,cni,flannel,cali,vxlan"),
		"comma-separated interface name prefixes to leave out (env OPENUPTIME_IGNORE_INTERFACES)")
	flag.StringVar(&cfg.name, "name", os.Getenv("OPENUPTIME_NAME"), "name the server gets when it first reports; defaults to the host name (env OPENUPTIME_NAME)")
	flag.StringVar(&tags, "tags", os.Getenv("OPENUPTIME_TAGS"), "comma-separated tags the server gets when it first reports (env OPENUPTIME_TAGS)")
	flag.BoolVar(&cfg.once, "once", false, "collect one report, print it as JSON and exit without sending")
	flag.BoolVar(&showVersion, "version", false, "print the version and exit")
	flag.Parse()
	if showVersion {
		fmt.Println(version)
		return
	}
	cfg.endpoint = strings.TrimRight(cfg.endpoint, "/")
	cfg.name = cutRunes(strings.TrimSpace(cfg.name), maxNameLen)
	cfg.tags = parseTags(tags)
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

// parseTags splits a comma-separated list, dropping blanks and repeats and keeping what the dashboard accepts.
func parseTags(s string) []string {
	var out []string
	seen := map[string]bool{}
	for _, t := range strings.Split(s, ",") {
		t = cutRunes(strings.TrimSpace(t), maxTagLen)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
		if len(out) == maxTags {
			break
		}
	}
	return out
}

func cutRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return strings.TrimSpace(string(r[:n]))
	}
	return s
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
		r.Name, r.Tags = cfg.name, cfg.tags
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
		r.Name, r.Tags = cfg.name, cfg.tags
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
