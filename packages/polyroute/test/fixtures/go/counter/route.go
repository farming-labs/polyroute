package main

import (
	"fmt"
	"net/http"
	"sync/atomic"

	"go.bytecodealliance.org/wasi/wasihttp"
)

var requests atomic.Uint32

func init() {
	wasihttp.HandleFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, requests.Add(1))
	})
}

func main() {}
