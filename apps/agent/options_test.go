package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseTags(t *testing.T) {
	cases := map[string][]string{
		"":                   nil,
		" , ,":               nil,
		"prod":               {"prod"},
		" prod , web,prod,,": {"prod", "web"},
		"生产,东京":              {"生产", "东京"},
	}
	for in, want := range cases {
		if got := parseTags(in); !reflect.DeepEqual(got, want) {
			t.Errorf("parseTags(%q) = %q, want %q", in, got, want)
		}
	}
	many := strings.Repeat("a,", 30)
	for i := 0; i < 30; i++ {
		many += string(rune('a'+i%26)) + strings.Repeat("x", i)
		many += ","
	}
	if got := parseTags(many); len(got) != maxTags {
		t.Errorf("kept %d tags, want %d", len(got), maxTags)
	}
	if got := parseTags(strings.Repeat("长", 40)); len([]rune(got[0])) != maxTagLen {
		t.Errorf("tag not cut to %d characters: %q", maxTagLen, got[0])
	}
}

func TestCutRunes(t *testing.T) {
	if got := cutRunes("web-01", maxNameLen); got != "web-01" {
		t.Errorf("short name changed: %q", got)
	}
	if got := cutRunes(strings.Repeat("服", 130), maxNameLen); len([]rune(got)) != maxNameLen {
		t.Errorf("name not cut to %d characters", maxNameLen)
	}
}
