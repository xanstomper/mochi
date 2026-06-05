package workspace

import (
	"context"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/catwalk/pkg/catwalk"
	"github.com/mochi/mochi/internal/agent"
	mcptools "github.com/mochi/mochi/internal/agent/tools/mcp"
	"github.com/mochi/mochi/internal/app"
	"github.com/mochi/mochi/internal/config"
	"github.com/mochi/mochi/internal/history"
	"github.com/mochi/mochi/internal/lsp"
	"github.com/mochi/mochi/internal/message"
	"github.com/mochi/mochi/internal/oauth"
	"github.com/mochi/mochi/internal/permission"
	"github.com/mochi/mochi/internal/session"
	"github.com/mochi/mochi/internal/skills"
)

// AgentModel describes the model currently in use by the agent.
type AgentModel struct {
	CatwalkCfg catwalk.Model
	ModelCfg   config.SelectedModel
}

// LSPClientInfo describes the state of a single LSP client.
type LSPClientInfo struct {
	Name            string
	State           lsp.ServerState
	Error           error
	DiagnosticCount int
	ConnectedAt     time.Time
}

// MCPResourceContents represents a single MCP resource.
type MCPResourceContents struct {
	URI      string
	MIMEType string
	Text     string
	Blob     []byte
}

// LSPEvent represents a single LSP state-change event.
type LSPEvent struct {
	Type            LSPEventType
	Client          string
	State           lsp.ServerState
	Error           error
	Name            string
	DiagnosticCount int
	Timestamp       time.Time
}

// LSPEventType is the kind of LSP event.
type LSPEventType string

const (
	LSPEventConnected    LSPEventType = "connected"
	LSPEventDisconnected LSPEventType = "disconnected"
	LSPEventError        LSPEventType = "error"
)

// Workspace is the top-level interface that mochi clients use to
// interact with the agent runtime. It hides the in-process app vs.
// client/server architecture from the rest of the system.
type Workspace interface {
	// -- Sessions --
	CreateSession(ctx context.Context, title string) (session.Session, error)
	GetSession(ctx context.Context, sessionID string) (session.Session, error)
	ListSessions(ctx context.Context) ([]session.Session, error)
	SaveSession(ctx context.Context, sess session.Session) (session.Session, error)
	DeleteSession(ctx context.Context, sessionID string) error
	CreateAgentToolSessionID(messageID, toolCallID string) string
	ParseAgentToolSessionID(sessionID string) (string, string, bool)
	SetCurrentSession(ctx context.Context, sessionID string) error

	// -- Messages --
	ListMessages(ctx context.Context, sessionID string) ([]message.Message, error)
	ListUserMessages(ctx context.Context, sessionID string) ([]message.Message, error)
	ListAllUserMessages(ctx context.Context) ([]message.Message, error)

	// -- Agent --
	AgentRun(ctx context.Context, sessionID, prompt string, attachments ...message.Attachment) error
	AgentCancel(sessionID string)
	AgentIsBusy() bool
	AgentIsSessionBusy(sessionID string) bool
	AgentModel() AgentModel
	AgentIsReady() bool
	AgentQueuedPrompts(sessionID string) int
	AgentQueuedPromptsList(sessionID string) []string
	AgentClearQueue(sessionID string)
	AgentSummarize(ctx context.Context, sessionID string) error
	UpdateAgentModel(ctx context.Context) error
	InitCoderAgent(ctx context.Context) error
	GetDefaultSmallModel(providerID string) config.SelectedModel

	// -- Permissions --
	PermissionGrant(perm permission.PermissionRequest) bool
	PermissionGrantPersistent(perm permission.PermissionRequest) bool
	PermissionDeny(perm permission.PermissionRequest) bool
	PermissionSkipRequests() bool
	PermissionSetSkipRequests(skip bool)

	// -- FileTracker --
	FileTrackerRecordRead(ctx context.Context, sessionID, path string)
	FileTrackerLastReadTime(ctx context.Context, sessionID, path string) time.Time
	FileTrackerListReadFiles(ctx context.Context, sessionID string) ([]string, error)

	// -- History --
	ListSessionHistory(ctx context.Context, sessionID string) ([]history.File, error)

	// -- LSP --
	LSPStart(ctx context.Context, path string)
	LSPStopAll(ctx context.Context)
	LSPGetStates() map[string]LSPClientInfo
	LSPGetDiagnosticCounts(name string) lsp.DiagnosticCounts

	// -- Config (read-only) --
	Config() *config.Config
	WorkingDir() string
	Resolver() config.VariableResolver

	// -- Config mutations --
	UpdatePreferredModel(scope config.Scope, modelType config.SelectedModelType, model config.SelectedModel) error
	SetCompactMode(scope config.Scope, enabled bool) error
	SetProviderAPIKey(scope config.Scope, providerID string, apiKey any) error
	SetConfigField(scope config.Scope, key string, value any) error
	RemoveConfigField(scope config.Scope, key string) error
	ImportCopilot() (*oauth.Token, bool)
	RefreshOAuthToken(ctx context.Context, scope config.Scope, providerID string) error

	// -- Project lifecycle --
	ProjectNeedsInitialization() (bool, error)
	MarkProjectInitialized() error
	InitializePrompt() (string, error)
	ListSkills(ctx context.Context) ([]skills.CatalogEntry, error)
	ReadSkill(ctx context.Context, skillID string) ([]byte, skills.SkillReadResult, error)

	// -- MCP operations --
	MCPGetStates() map[string]mcptools.ClientInfo
	MCPRefreshPrompts(ctx context.Context, name string)
	MCPRefreshResources(ctx context.Context, name string)
	RefreshMCPTools(ctx context.Context, name string)
	ReadMCPResource(ctx context.Context, name, uri string) ([]MCPResourceContents, error)
	GetMCPPrompt(clientID, promptID string, args map[string]string) (string, error)
	EnableDockerMCP(ctx context.Context) error
	DisableDockerMCP() error

	// -- Lifecycle --
	Subscribe(program *tea.Program)
	Shutdown()

	// -- Accessors --
	AgentCoordinator() agent.Coordinator
	App() *app.App
	Store() *config.ConfigStore
}
