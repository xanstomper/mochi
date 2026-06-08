package message

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/mochi/mochi/internal/db"
	"github.com/mochi/mochi/internal/pubsub"
)

// partType discriminates ContentPart types during JSON serialization.
type partType string

const (
	reasoningType  partType = "reasoning"
	textType       partType = "text"
	imageURLType   partType = "image_url"
	binaryType     partType = "binary"
	toolCallType   partType = "tool_call"
	toolResultType partType = "tool_result"
	finishType     partType = "finish"
)

// partWrapper wraps a ContentPart with its type for JSON round-tripping.
type partWrapper struct {
	Type partType    `json:"type"`
	Data ContentPart `json:"data"`
}

func marshalParts(parts []ContentPart) ([]byte, error) {
	wrapped := make([]partWrapper, len(parts))
	for i, part := range parts {
		var typ partType
		switch part.(type) {
		case ReasoningContent:
			typ = reasoningType
		case TextContent:
			typ = textType
		case ImageURLContent:
			typ = imageURLType
		case BinaryContent:
			typ = binaryType
		case ToolCall:
			typ = toolCallType
		case ToolResult:
			typ = toolResultType
		case Finish:
			typ = finishType
		default:
			return nil, fmt.Errorf("unknown part type: %T", part)
		}
		wrapped[i] = partWrapper{Type: typ, Data: part}
	}
	return json.Marshal(wrapped)
}

func unmarshalParts(data []byte) ([]ContentPart, error) {
	var wrapped []partWrapper
	if err := json.Unmarshal(data, &wrapped); err != nil {
		return nil, fmt.Errorf("unmarshal part wrappers: %w", err)
	}
	parts := make([]ContentPart, 0, len(wrapped))
	for _, w := range wrapped {
		// JSON unmarshal into interface needs explicit decoder
		raw, err := json.Marshal(w.Data)
		if err != nil {
			return nil, fmt.Errorf("re-marshal %s data: %w", w.Type, err)
		}
		var part ContentPart
		switch w.Type {
		case reasoningType:
			var p ReasoningContent
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, fmt.Errorf("unmarshal reasoning: %w", err)
			}
			part = p
		case textType:
			var p TextContent
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, fmt.Errorf("unmarshal text: %w", err)
			}
			part = p
		case imageURLType:
			var p ImageURLContent
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, fmt.Errorf("unmarshal image_url: %w", err)
			}
			part = p
		case binaryType:
			var p BinaryContent
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, fmt.Errorf("unmarshal binary: %w", err)
			}
			part = p
		case toolCallType:
			var p ToolCall
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, fmt.Errorf("unmarshal tool_call: %w", err)
			}
			part = p
		case toolResultType:
			var p ToolResult
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, fmt.Errorf("unmarshal tool_result: %w", err)
			}
			part = p
		case finishType:
			var p Finish
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, fmt.Errorf("unmarshal finish: %w", err)
			}
			part = p
		default:
			return nil, fmt.Errorf("unknown part type: %s", w.Type)
		}
		parts = append(parts, part)
	}
	return parts, nil
}

// DurableService extends MemService with SQLite persistence.
// All creates/updates/deletes are written through to SQLite so conversation
// history survives process restarts. On first access to a session's messages,
// they are lazy-loaded from SQLite into the in-memory store.
type DurableService struct {
	inner    *MemService
	queries  *db.Queries
	conn     *sql.DB

	loadedMu sync.Mutex
	loaded   map[string]bool // sessionID → whether loaded from DB

	debounceMu sync.Mutex
	debounce   map[string]*time.Timer
}

// NewDurableService creates a MemService wrapped with SQLite persistence.
func NewDurableService(q *db.Queries, conn *sql.DB) *DurableService {
	return &DurableService{
		inner:    NewService(),
		queries:  q,
		conn:     conn,
		loaded:   make(map[string]bool),
		debounce: make(map[string]*time.Timer),
	}
}

// ensureLoaded lazy-loads messages from SQLite for the given session.
func (s *DurableService) ensureLoaded(ctx context.Context, sessionID string) error {
	s.loadedMu.Lock()
	if s.loaded[sessionID] {
		s.loadedMu.Unlock()
		return nil
	}
	s.loadedMu.Unlock()

	dbMsgs, err := s.queries.ListMessagesBySession(ctx, sessionID)
	if err != nil {
		// Table might not have any messages for this session — not an error
		slog.Debug("No persisted messages for session", "session", sessionID)
		s.loadedMu.Lock()
		s.loaded[sessionID] = true
		s.loadedMu.Unlock()
		return nil
	}

	msgs := make([]Message, 0, len(dbMsgs))
	for _, dbMsg := range dbMsgs {
		parts, err := unmarshalParts([]byte(dbMsg.Parts))
		if err != nil {
			slog.Error("Failed to unmarshal message parts",
				"id", dbMsg.ID, "session", sessionID, "error", err)
			continue
		}
		msgs = append(msgs, Message{
			ID:        dbMsg.ID,
			SessionID: dbMsg.SessionID,
			Role:      MessageRole(dbMsg.Role),
			Parts:     parts,
			Model:     dbMsg.Model.String,
			Provider:  dbMsg.Provider.String,
			CreatedAt: dbMsg.CreatedAt,
			UpdatedAt: dbMsg.UpdatedAt,
			IsSummaryMessage: dbMsg.IsSummaryMessage == 1,
		})
	}

	s.inner.importMessages(ctx, msgs)

	s.loadedMu.Lock()
	s.loaded[sessionID] = true
	s.loadedMu.Unlock()
	return nil
}

// flushMessage writes a single message's current state to SQLite.
func (s *DurableService) flushMessage(ctx context.Context, id string) {
	msg, err := s.inner.Get(ctx, id)
	if err != nil {
		return
	}

	partsJSON, err := marshalParts(msg.Parts)
	if err != nil {
		slog.Error("Failed to marshal parts for flush", "id", id, "error", err)
		return
	}

	var finishedAt sql.NullInt64
	if msg.IsFinished() {
		finishedAt = sql.NullInt64{Int64: time.Now().UnixMilli(), Valid: true}
	}

	if err := s.queries.UpdateMessage(ctx, db.UpdateMessageParams{
		Parts:      string(partsJSON),
		FinishedAt: finishedAt,
		ID:         id,
	}); err != nil {
		slog.Error("Failed to flush message", "id", id, "error", err)
	}
}

// --- Service interface implementation ---

func (s *DurableService) Create(ctx context.Context, sessionID string, params CreateMessageParams) (Message, error) {
	msg, err := s.inner.Create(ctx, sessionID, params)
	if err != nil {
		return Message{}, err
	}

	partsJSON, marshalErr := marshalParts(msg.Parts)
	if marshalErr != nil {
		slog.Error("Failed to marshal parts for create", "id", msg.ID, "error", marshalErr)
		return msg, nil // non-fatal — message exists in memory
	}

	if _, dbErr := s.queries.CreateMessage(ctx, db.CreateMessageParams{
		ID:        msg.ID,
		SessionID: msg.SessionID,
		Role:      string(msg.Role),
		Parts:     string(partsJSON),
		Model:     sql.NullString{String: msg.Model, Valid: msg.Model != ""},
		Provider:  sql.NullString{String: msg.Provider, Valid: msg.Provider != ""},
		IsSummaryMessage: boolToInt(msg.IsSummaryMessage),
	}); dbErr != nil {
		slog.Error("Failed to persist message create", "id", msg.ID, "error", dbErr)
	}
	return msg, nil
}

func (s *DurableService) Get(ctx context.Context, id string) (Message, error) {
	return s.inner.Get(ctx, id)
}

func (s *DurableService) List(ctx context.Context, sessionID string) ([]Message, error) {
	if err := s.ensureLoaded(ctx, sessionID); err != nil {
		return nil, err
	}
	return s.inner.List(ctx, sessionID)
}

func (s *DurableService) ListUserMessages(ctx context.Context, sessionID string) ([]Message, error) {
	if err := s.ensureLoaded(ctx, sessionID); err != nil {
		return nil, err
	}
	return s.inner.ListUserMessages(ctx, sessionID)
}

func (s *DurableService) ListAllUserMessages(ctx context.Context) ([]Message, error) {
	// Load all sessions that have messages in SQLite
	allMsgs, err := s.queries.ListAllUserMessages(ctx)
	if err != nil {
		return nil, err
	}
	// Group by session and load unloaded ones
	seen := make(map[string]bool)
	for _, dbMsg := range allMsgs {
		if !seen[dbMsg.SessionID] {
			seen[dbMsg.SessionID] = true
			_ = s.ensureLoaded(ctx, dbMsg.SessionID)
		}
	}
	return s.inner.ListAllUserMessages(ctx)
}

func (s *DurableService) Update(ctx context.Context, msg Message) error {
	if err := s.inner.Update(ctx, msg); err != nil {
		return err
	}

	// Debounce SQLite writes for streaming updates
	s.debounceMu.Lock()
	if t, ok := s.debounce[msg.ID]; ok {
		t.Stop()
	}
	s.debounce[msg.ID] = time.AfterFunc(200*time.Millisecond, func() {
		s.flushMessage(context.Background(), msg.ID)
		s.debounceMu.Lock()
		delete(s.debounce, msg.ID)
		s.debounceMu.Unlock()
	})
	s.debounceMu.Unlock()
	return nil
}

func (s *DurableService) Delete(ctx context.Context, id string) error {
	// Delete from SQLite first — fail-closed
	if err := s.queries.DeleteMessage(ctx, id); err != nil {
		return fmt.Errorf("delete message from db: %w", err)
	}
	return s.inner.Delete(ctx, id)
}

func (s *DurableService) DeleteSession(ctx context.Context, sessionID string) error {
	if err := s.queries.DeleteSessionMessages(ctx, sessionID); err != nil {
		return fmt.Errorf("delete session messages from db: %w", err)
	}
	_ = s.ensureLoaded(ctx, sessionID) // best-effort
	return s.inner.DeleteSession(ctx, sessionID)
}

func (s *DurableService) Subscribe(ctx context.Context) <-chan pubsub.Event[Message] {
	return s.inner.Subscribe(ctx)
}

func (s *DurableService) FlushAll(ctx context.Context) error {
	// Flush all pending debounced writes
	s.debounceMu.Lock()
	ids := make([]string, 0, len(s.debounce))
	for id, t := range s.debounce {
		t.Stop()
		ids = append(ids, id)
	}
	s.debounceMu.Unlock()

	for _, id := range ids {
		s.flushMessage(ctx, id)
	}
	return s.inner.FlushAll(ctx)
}

func boolToInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}
