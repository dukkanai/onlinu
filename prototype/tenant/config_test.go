package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMountedSecretsFailClosed(t *testing.T) {
	const name = "TENANT_TEST_CREDENTIAL"
	t.Setenv(name, "inline-test")
	t.Setenv(name+"_FILE", "")
	if value, err := secretValue(name); err != nil || value != "inline-test" {
		t.Fatal("inline local credential failed")
	}
	path := filepath.Join(t.TempDir(), "credential")
	if err := os.WriteFile(path, []byte("fixture-file\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(name+"_FILE", path)
	if _, err := secretValue(name); err == nil {
		t.Fatal("ambiguous credential sources accepted")
	}
	t.Setenv(name, "")
	if value, err := secretValue(name); err != nil || value != "fixture-file" {
		t.Fatal("mounted credential failed")
	}
	t.Setenv(name+"_FILE", path+"-absent")
	if _, err := secretValue(name); err == nil {
		t.Fatal("missing mounted secret accepted")
	}
}
