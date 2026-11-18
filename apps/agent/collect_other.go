//go:build !linux

package main

import (
	"errors"
	"runtime"
)

type collector struct{}

func newCollector([]string) (*collector, error) {
	return nil, errors.New("openuptime-agent runs on Linux only, not " + runtime.GOOS)
}

func (c *collector) collect() (*report, error) { return nil, errors.New("unsupported") }
