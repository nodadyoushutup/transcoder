import { connectPlex, disconnectPlex } from '../../../lib/api.js';
import {
  BooleanField,
  DiffButton,
  Feedback,
  SectionContainer,
  TextField,
} from '../shared.jsx';

export default function PlexSection({ plex, setPlex }) {
  const updatePlexForm = (changes) => {
    setPlex((state) => ({
      ...state,
      form: { ...state.form, ...changes },
      feedback: null,
    }));
  };

  const handleConnect = async () => {
    const serverUrl = plex.form.serverUrl ? plex.form.serverUrl.trim() : '';
    const token = plex.form.token ? plex.form.token.trim() : '';

    if (!serverUrl) {
      setPlex((state) => ({
        ...state,
        feedback: { tone: 'error', message: 'Server URL is required.' },
      }));
      return;
    }
    if (!token) {
      setPlex((state) => ({
        ...state,
        feedback: { tone: 'error', message: 'Plex token is required.' },
      }));
      return;
    }

    setPlex((state) => ({
      ...state,
      saving: true,
      feedback: { tone: 'info', message: 'Connecting to Plex…' },
    }));

    try {
      const response = await connectPlex({
        serverUrl,
        token,
        verifySsl: plex.form.verifySsl,
      });
      const result = response?.result || {};
      const nextSettings = response?.settings || {};
      setPlex((state) => ({
        ...state,
        loading: false,
        status: result.status || nextSettings.status || 'connected',
        account: result.account ?? nextSettings.account ?? state.account,
        server: result.server ?? nextSettings.server ?? state.server,
        hasToken: Boolean(nextSettings.has_token ?? result.has_token ?? true),
        lastConnectedAt:
          result.last_connected_at
          ?? nextSettings.last_connected_at
          ?? new Date().toISOString(),
        feedback: { tone: 'success', message: 'Connected to Plex.' },
        saving: false,
        form: {
          ...state.form,
          serverUrl: nextSettings.server_base_url ?? serverUrl,
          token: '',
          verifySsl:
            nextSettings.verify_ssl !== undefined
              ? Boolean(nextSettings.verify_ssl)
              : (result.verify_ssl !== undefined
                  ? Boolean(result.verify_ssl)
                  : state.form.verifySsl),
        },
      }));
    } catch (exc) {
      let message = 'Unable to connect to Plex.';
      if (exc instanceof TypeError) {
        console.error('Plex connect network error', exc);
        message = 'Could not reach the API. Ensure the backend is running and configure CORS/HTTPS correctly.';
      } else if (exc instanceof Error && exc.message) {
        message = exc.message;
      }
      setPlex((state) => ({
        ...state,
        saving: false,
        feedback: { tone: 'error', message },
      }));
    }
  };

  const handleDisconnect = async () => {
    setPlex((state) => ({
      ...state,
      saving: true,
      feedback: { tone: 'info', message: 'Disconnecting Plex…' },
    }));
    try {
      await disconnectPlex();
      setPlex((state) => ({
        ...state,
        saving: false,
        feedback: { tone: 'success', message: 'Plex disconnected.' },
        hasToken: false,
        server: null,
        account: null,
        status: 'disconnected',
        form: {
          ...state.form,
          token: '',
        },
      }));
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : 'Unable to disconnect Plex.';
      setPlex((state) => ({
        ...state,
        saving: false,
        feedback: { tone: 'error', message },
      }));
    }
  };

  if (plex.loading) {
    return <div className="text-sm text-muted">Loading Plex status…</div>;
  }

  const isConnected = plex.status === 'connected';
  const lastConnected = plex.lastConnectedAt ? new Date(plex.lastConnectedAt) : null;

  return (
    <SectionContainer title="Plex integration">
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          label="Server URL"
          value={plex.form.serverUrl}
          onChange={(value) => updatePlexForm({ serverUrl: value })}
          placeholder="https://plex.example.com"
        />
        <TextField
          label="Token"
          value={plex.form.token}
          onChange={(value) => updatePlexForm({ token: value })}
          placeholder="Plex authentication token"
          helpText="Generate a token via Plex account settings."
        />
        <BooleanField
          label="Verify TLS certificates"
          value={plex.form.verifySsl}
          onChange={(value) => updatePlexForm({ verifySsl: value })}
          helpText="Disable only if you are using a self-signed certificate."
        />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-border bg-background/70 p-4 text-sm text-muted">
          <p className="text-xs uppercase tracking-wide text-subtle">Status</p>
          <p className="text-base font-semibold text-foreground">{isConnected ? 'Connected' : 'Disconnected'}</p>
          {lastConnected ? (
            <p className="text-xs text-subtle">Last connected {lastConnected.toLocaleString()}</p>
          ) : null}
        </div>

        {isConnected ? (
          <div className="space-y-3 rounded-2xl border border-border bg-background/70 p-4 text-sm text-muted">
            {plex.account ? (
              <div className="space-y-2">
                <div>
                  <p className="text-base font-semibold text-foreground">{plex.account.title || plex.account.username}</p>
                  {plex.account.email ? <p className="text-xs text-subtle">{plex.account.email}</p> : null}
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-subtle">
                  {plex.account.subscription_status ? <span>Status: {plex.account.subscription_status}</span> : null}
                  {plex.account.subscription_plan ? <span>Plan: {plex.account.subscription_plan}</span> : null}
                  {plex.account.uuid ? <span>UUID: {plex.account.uuid}</span> : null}
                </div>
              </div>
            ) : (
              <p className="text-xs text-subtle">Connected to Plex server.</p>
            )}
            {plex.server ? (
              <div className="space-y-1 text-xs text-subtle">
                <p className="text-sm text-muted">
                  <span className="text-foreground font-semibold">{plex.server.name || 'Plex server'}</span>
                  {plex.server.base_url ? ` · ${plex.server.base_url}` : ''}
                </p>
                <div className="flex flex-wrap gap-3">
                  {plex.server.machine_identifier ? <span>ID: {plex.server.machine_identifier}</span> : null}
                  {plex.server.version ? <span>Version: {plex.server.version}</span> : null}
                  {plex.server.verify_ssl !== undefined ? (
                    <span>TLS: {plex.server.verify_ssl ? 'verified' : 'not verified'}</span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {plex.hasToken && !isConnected ? (
        <p className="mt-2 text-xs text-subtle">
          A Plex token is already stored; submitting a new token will replace it.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        <DiffButton onClick={handleConnect} disabled={plex.saving}>
          {plex.saving ? 'Working…' : 'Connect'}
        </DiffButton>
        {plex.hasToken ? (
          <DiffButton onClick={handleDisconnect} disabled={plex.saving}>
            {plex.saving ? 'Working…' : 'Disconnect'}
          </DiffButton>
        ) : null}
      </div>
      <Feedback message={plex.feedback?.message} tone={plex.feedback?.tone} />
    </SectionContainer>
  );
}
