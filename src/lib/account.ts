import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import type { CloudCampaignSave, GameState } from "../types";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim();
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
const CAMPAIGN_SAVES_TABLE = "campaign_saves";

let client: SupabaseClient | null = null;

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
  provider: string;
  emailVerified: boolean;
}

interface CampaignSaveRow {
  id: string;
  title: string;
  game_state: GameState;
  selected_npc_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapUser(user: User | null): AccountUser | null {
  if (!user?.email) {
    return null;
  }

  const identities = user.identities ?? [];
  const provider = identities[0]?.provider ?? user.app_metadata.provider ?? "email";
  const displayName =
    (typeof user.user_metadata.full_name === "string" && user.user_metadata.full_name) ||
    (typeof user.user_metadata.name === "string" && user.user_metadata.name) ||
    user.email;

  return {
    id: user.id,
    email: user.email,
    displayName,
    provider,
    emailVerified: Boolean(user.email_confirmed_at),
  };
}

function mapSave(row: CampaignSaveRow): CloudCampaignSave {
  return {
    id: row.id,
    title: row.title,
    game: row.game_state,
    selectedNpcId: row.selected_npc_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "Supabase auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.",
    );
  }

  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    });
  }

  return client;
}

async function requireUser(): Promise<AccountUser> {
  const user = await getCurrentAccountUser();
  if (!user) {
    throw new Error("Sign in before loading or syncing cloud history.");
  }
  return user;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export async function getCurrentAccountUser(): Promise<AccountUser | null> {
  if (!isSupabaseConfigured()) {
    return null;
  }

  const supabase = requireClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    throw error;
  }

  return mapUser(user);
}

export function subscribeToAccountChanges(
  callback: (user: AccountUser | null, event: AuthChangeEvent, session: Session | null) => void,
): () => void {
  if (!isSupabaseConfigured()) {
    return () => undefined;
  }

  const supabase = requireClient();
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event, session) => {
    callback(mapUser(session?.user ?? null), event, session);
  });

  return () => subscription.unsubscribe();
}

export async function signUpWithEmail(email: string, password: string): Promise<{
  user: AccountUser | null;
  needsEmailVerification: boolean;
}> {
  const supabase = requireClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: window.location.origin,
    },
  });

  if (error) {
    throw error;
  }

  return {
    user: mapUser(data.user),
    needsEmailVerification: !data.session,
  };
}

export async function signInWithEmail(email: string, password: string): Promise<AccountUser | null> {
  const supabase = requireClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw error;
  }

  return mapUser(data.user);
}

export async function signInWithGoogle(): Promise<void> {
  const supabase = requireClient();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin,
      queryParams: {
        access_type: "offline",
        prompt: "select_account",
      },
    },
  });

  if (error) {
    throw error;
  }
}

export async function signOutAccount(): Promise<void> {
  const supabase = requireClient();
  const { error } = await supabase.auth.signOut();
  if (error) {
    throw error;
  }
}

export async function listCloudCampaignSaves(): Promise<CloudCampaignSave[]> {
  const user = await requireUser();
  const supabase = requireClient();
  const { data, error } = await supabase
    .from(CAMPAIGN_SAVES_TABLE)
    .select("id, title, game_state, selected_npc_id, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data as CampaignSaveRow[]).map(mapSave);
}

export async function saveCloudCampaign(input: {
  saveId?: string;
  title: string;
  game: GameState;
  selectedNpcId?: string;
}): Promise<CloudCampaignSave> {
  const user = await requireUser();
  const supabase = requireClient();
  const payload = {
    id: input.saveId,
    user_id: user.id,
    title: input.title,
    game_state: input.game,
    selected_npc_id: input.selectedNpcId ?? null,
    updated_at: new Date().toISOString(),
  };

  const query = input.saveId
    ? supabase
        .from(CAMPAIGN_SAVES_TABLE)
        .update(payload)
        .eq("id", input.saveId)
        .eq("user_id", user.id)
        .select("id, title, game_state, selected_npc_id, created_at, updated_at")
        .single()
    : supabase
        .from(CAMPAIGN_SAVES_TABLE)
        .insert(payload)
        .select("id, title, game_state, selected_npc_id, created_at, updated_at")
        .single();

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  return mapSave(data as CampaignSaveRow);
}

export async function deleteCloudCampaign(saveId: string): Promise<void> {
  const user = await requireUser();
  const supabase = requireClient();
  const { error } = await supabase
    .from(CAMPAIGN_SAVES_TABLE)
    .delete()
    .eq("id", saveId)
    .eq("user_id", user.id);

  if (error) {
    throw error;
  }
}