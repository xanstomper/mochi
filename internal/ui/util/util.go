// Package util provides utility functions for UI message handling.
package util

import (
	"context"
	"errors"
	"os/exec"
	"time"

	"github.com/xanstomper/mofu"
	"mvdan.cc/sh/v3/shell"
)

type Cursor interface {
	SetPosition(x, y int) string
}

func CmdHandler(msg mofu.Msg) mofu.Cmd {
	return func() mofu.Msg {
		return msg
	}
}

func ReportError(err error) mofu.Cmd {
	return CmdHandler(NewErrorMsg(err))
}

type InfoType int

const (
	InfoTypeInfo InfoType = iota
	InfoTypeSuccess
	InfoTypeWarn
	InfoTypeError
	InfoTypeUpdate
)

func NewInfoMsg(info string) InfoMsg {
	return InfoMsg{
		Type: InfoTypeInfo,
		Msg:  info,
	}
}

func NewWarnMsg(warn string) InfoMsg {
	return InfoMsg{
		Type: InfoTypeWarn,
		Msg:  warn,
	}
}

func NewErrorMsg(err error) InfoMsg {
	return InfoMsg{
		Type: InfoTypeError,
		Msg:  err.Error(),
	}
}

func ReportInfo(info string) mofu.Cmd {
	return CmdHandler(NewInfoMsg(info))
}

func ReportWarn(warn string) mofu.Cmd {
	return CmdHandler(NewWarnMsg(warn))
}

type (
	InfoMsg struct {
		Type InfoType
		Msg  string
		TTL  time.Duration
	}
	ClearStatusMsg struct{}
)

func (m InfoMsg) IsEmpty() bool {
	var zero InfoMsg
	return m == zero
}

func ExecShell(ctx context.Context, cmdStr string, callback func(error) mofu.Msg) mofu.Cmd {
	fields, err := shell.Fields(cmdStr, nil)
	if err != nil {
		return ReportError(err)
	}
	if len(fields) == 0 {
		return ReportError(errors.New("empty command"))
	}

	cmd := exec.CommandContext(ctx, fields[0], fields[1:]...)
	return func() mofu.Msg {
		err := cmd.Run()
		if callback != nil {
			return callback(err)
		}
		return nil
	}
}
