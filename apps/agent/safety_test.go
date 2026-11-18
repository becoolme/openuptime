package main

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The dashboard and the docs promise that the agent only reports: it cannot run commands, load code or open a port.
// This keeps the packages that could do any of that out of the agent.
func TestAgentCannotRunCommands(t *testing.T) {
	banned := map[string]bool{"os/exec": true, "plugin": true, "net/http/cgi": true, "net/rpc": true, "unsafe": true, "golang.org/x/sys/unix": true}
	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("no sources: %v", err)
	}
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), f, src, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range parsed.Imports {
			path, _ := strconv.Unquote(imp.Path.Value)
			if banned[path] {
				t.Errorf("%s imports %s; the agent must stay report-only", f, path)
			}
		}
		// process starts outside os/exec, and raw syscalls that could reach execve
		for _, run := range []string{"syscall.Exec", "ForkExec", "StartProcess", "SYS_EXECVE", "syscall.Syscall", "syscall.RawSyscall", "unix.Exec"} {
			if !strings.HasSuffix(f, "_test.go") && strings.Contains(string(src), run) {
				t.Errorf("%s uses %s; the agent must stay report-only", f, run)
			}
		}
		// net.Listen also catches ListenTCP, ListenUDP, ListenPacket, ListenUnix and ListenConfig
		for _, listen := range []string{"net.Listen", "http.ListenAndServe", "http.Serve(", ".Serve(", "ListenPacket"} {
			if !strings.HasSuffix(f, "_test.go") && strings.Contains(string(src), listen) {
				t.Errorf("%s calls %s; the agent must not listen", f, listen)
			}
		}
	}
}
