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
	banned := map[string]bool{"os/exec": true, "plugin": true, "net/http/cgi": true, "net/rpc": true, "unsafe": true}
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
		if !strings.HasSuffix(f, "_test.go") && strings.Contains(string(src), "syscall.Exec") {
			t.Errorf("%s calls syscall.Exec", f)
		}
		for _, listen := range []string{"net.Listen", "http.ListenAndServe", "http.Serve("} {
			if !strings.HasSuffix(f, "_test.go") && strings.Contains(string(src), listen) {
				t.Errorf("%s calls %s; the agent must not listen", f, listen)
			}
		}
	}
}
