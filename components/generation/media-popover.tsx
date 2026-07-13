'use client';

import { useState, useMemo, Fragment } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Image as ImageIcon,
  Video,
  Volume2,
  Mic,
  SlidersHorizontal,
  ChevronRight,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { CUSTOM_ASR_DEFAULT_LANGUAGES } from '@/lib/audio/constants';
import { ASR_PROVIDERS, getASRSupportedLanguages } from '@/lib/audio/constants';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import type { ASRProviderId } from '@/lib/audio/types';
import { isCustomASRProvider } from '@/lib/audio/types';
import type { SettingsSection } from '@/lib/types/settings';

interface MediaPopoverProps {
  onSettingsOpen: (section: SettingsSection) => void;
}

type TabId = 'image' | 'video' | 'tts' | 'asr';

const TABS: Array<{ id: TabId; icon: LucideIcon; label: string }> = [
  { id: 'image', icon: ImageIcon, label: 'Image' },
  { id: 'video', icon: Video, label: 'Video' },
  { id: 'tts', icon: Volume2, label: 'TTS' },
  { id: 'asr', icon: Mic, label: 'ASR' },
];

// Whether a provider's config satisfies its key requirement. Pure (no closure
// state), so it lives at module scope rather than as a useCallback.
function cfgOk(
  configs: Record<string, { apiKey?: string; isServerConfigured?: boolean }>,
  id: string,
  needsKey: boolean,
): boolean {
  return !needsKey || !!configs[id]?.apiKey || !!configs[id]?.isServerConfigured;
}

export function MediaPopover({ onSettingsOpen }: MediaPopoverProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('image');

  // ─── Store ───
  const imageGenerationEnabled = useSettingsStore((s) => s.imageGenerationEnabled);
  const videoGenerationEnabled = useSettingsStore((s) => s.videoGenerationEnabled);
  const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);
  const asrEnabled = useSettingsStore((s) => s.asrEnabled);
  const setImageGenerationEnabled = useSettingsStore((s) => s.setImageGenerationEnabled);
  const setVideoGenerationEnabled = useSettingsStore((s) => s.setVideoGenerationEnabled);
  const setTTSEnabled = useSettingsStore((s) => s.setTTSEnabled);
  const setASREnabled = useSettingsStore((s) => s.setASREnabled);

  const imageProviderId = useSettingsStore((s) => s.imageProviderId);
  const imageModelId = useSettingsStore((s) => s.imageModelId);
  const imageProvidersConfig = useSettingsStore((s) => s.imageProvidersConfig);
  const setImageProvider = useSettingsStore((s) => s.setImageProvider);
  const setImageModelId = useSettingsStore((s) => s.setImageModelId);

  const videoProviderId = useSettingsStore((s) => s.videoProviderId);
  const videoModelId = useSettingsStore((s) => s.videoModelId);
  const videoProvidersConfig = useSettingsStore((s) => s.videoProvidersConfig);
  const setVideoProvider = useSettingsStore((s) => s.setVideoProvider);
  const setVideoModelId = useSettingsStore((s) => s.setVideoModelId);

  const asrProviderId = useSettingsStore((s) => s.asrProviderId);
  const asrLanguage = useSettingsStore((s) => s.asrLanguage);
  const asrProvidersConfig = useSettingsStore((s) => s.asrProvidersConfig);
  const setASRProvider = useSettingsStore((s) => s.setASRProvider);
  const setASRLanguage = useSettingsStore((s) => s.setASRLanguage);

  const enabledMap: Record<TabId, boolean> = {
    image: imageGenerationEnabled,
    video: videoGenerationEnabled,
    tts: ttsEnabled,
    asr: asrEnabled,
  };

  const enabledCount = Object.values(enabledMap).filter(Boolean).length;

  // ─── Grouped select data (only available providers) ───
  const imageGroups = useMemo(
    () =>
      Object.values(IMAGE_PROVIDERS)
        .filter((p) => cfgOk(imageProvidersConfig, p.id, p.requiresApiKey))
        .map((p) => ({
          groupId: p.id,
          groupName: p.name,
          groupIcon: p.icon,
          items: [
            ...p.models,
            // Dedupe customModels vs built-in: a model promoted to built-in (or
            // carried over from an older schema) must not also linger as custom —
            // two same ids => duplicate React keys.
            ...(imageProvidersConfig[p.id]?.customModels || []).filter(
              (c) => !p.models.some((b) => b.id === c.id),
            ),
          ].map((m) => ({
            id: m.id,
            name: m.name,
          })),
        })),
    [imageProvidersConfig],
  );

  const videoGroups = useMemo(
    () =>
      Object.values(VIDEO_PROVIDERS)
        .filter((p) => cfgOk(videoProvidersConfig, p.id, p.requiresApiKey))
        .map((p) => ({
          groupId: p.id,
          groupName: p.name,
          groupIcon: p.icon,
          items: [
            ...p.models,
            ...(videoProvidersConfig[p.id]?.customModels || []).filter(
              (c) => !p.models.some((b) => b.id === c.id),
            ),
          ].map((m) => ({
            id: m.id,
            name: m.name,
          })),
        })),
    [videoProvidersConfig],
  );

  // ASR: built-in + custom providers
  const asrGroups = useMemo(() => {
    const groups: SelectGroupData[] = [];

    // Built-in providers
    for (const p of Object.values(ASR_PROVIDERS)) {
      if (!cfgOk(asrProvidersConfig, p.id, p.requiresApiKey)) continue;
      groups.push({
        groupId: p.id,
        groupName: p.name,
        groupIcon: p.icon,
        items: getASRSupportedLanguages(p.id).map((l) => ({
          id: l,
          name: l,
        })),
      });
    }

    // Custom providers — only show if at least one model is configured
    for (const [id, cfg] of Object.entries(asrProvidersConfig)) {
      if (!isCustomASRProvider(id)) continue;
      const customModels = cfg.customModels || [];
      if (customModels.length === 0) continue;
      const providerName = cfg.customName || id;
      groups.push({
        groupId: id,
        groupName: providerName,
        items: CUSTOM_ASR_DEFAULT_LANGUAGES.map((l) => ({ id: l, name: l })),
      });
    }

    return groups;
  }, [asrProvidersConfig]);

  // Auto-select first enabled tab on open
  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      const first = (['image', 'video', 'tts', 'asr'] as TabId[]).find((id) => enabledMap[id]);
      setActiveTab(first || 'image');
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all cursor-pointer select-none whitespace-nowrap border',
            enabledCount > 0
              ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-200/60 dark:border-violet-700/50'
              : 'text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 border-border/50',
          )}
        >
          <SlidersHorizontal className="size-3.5" />
          {imageGenerationEnabled && <ImageIcon className="size-3.5" />}
          {videoGenerationEnabled && <Video className="size-3.5" />}
          {ttsEnabled && <Volume2 className="size-3.5" />}
          {asrEnabled && <Mic className="size-3.5" />}
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" side="bottom" avoidCollisions={false} className="w-80 p-0">
        {/* ── Tab bar (segmented control) ── */}
        <div className="p-2 pb-0">
          <div className="flex gap-0.5 p-0.5 bg-muted/60 rounded-lg">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const isEnabled = enabledMap[tab.id];
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-medium transition-all relative',
                    isActive
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground/80',
                  )}
                >
                  <Icon className="size-3.5" />
                  <span className="hidden sm:inline">{tab.label}</span>
                  {isEnabled && !isActive && (
                    <span className="absolute top-1 right-1 size-1.5 rounded-full bg-violet-500" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Tab content ── */}
        <div className="p-3 pt-2.5">
          {activeTab === 'image' && (
            <TabPanel
              icon={ImageIcon}
              label={t('media.imageCapability')}
              enabled={imageGenerationEnabled}
              onToggle={setImageGenerationEnabled}
            >
              <GroupedSelect
                groups={imageGroups}
                selectedGroupId={imageProviderId}
                selectedItemId={imageModelId}
                onSelect={(gid, iid) => {
                  setImageProvider(gid as ImageProviderId);
                  setImageModelId(iid);
                }}
              />
            </TabPanel>
          )}

          {activeTab === 'video' && (
            <TabPanel
              icon={Video}
              label={t('media.videoCapability')}
              enabled={videoGenerationEnabled}
              onToggle={setVideoGenerationEnabled}
            >
              <GroupedSelect
                groups={videoGroups}
                selectedGroupId={videoProviderId}
                selectedItemId={videoModelId}
                onSelect={(gid, iid) => {
                  setVideoProvider(gid as VideoProviderId);
                  setVideoModelId(iid);
                }}
              />
            </TabPanel>
          )}

          {activeTab === 'tts' && (
            <TabPanel
              icon={Volume2}
              label={t('media.ttsCapability')}
              enabled={ttsEnabled}
              onToggle={setTTSEnabled}
            />
          )}

          {activeTab === 'asr' && (
            <TabPanel
              icon={Mic}
              label={t('media.asrCapability')}
              enabled={asrEnabled}
              onToggle={setASREnabled}
            >
              <GroupedSelect
                groups={asrGroups}
                selectedGroupId={asrProviderId}
                selectedItemId={asrLanguage}
                onSelect={(gid, iid) => {
                  setASRProvider(gid as ASRProviderId);
                  setASRLanguage(iid);
                }}
              />
            </TabPanel>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="border-t border-border/40">
          <button
            onClick={() => {
              setOpen(false);
              onSettingsOpen(activeTab);
            }}
            className="w-full flex items-center justify-between px-3.5 py-2.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            <span>{t('toolbar.advancedSettings')}</span>
            <ChevronRight className="size-3" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Tab panel: header (label + switch) + optional body ───
function TabPanel({
  icon: Icon,
  label,
  enabled,
  onToggle,
  children,
}: {
  icon: LucideIcon;
  label: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <Icon
          className={cn(
            'size-4 shrink-0 transition-colors',
            enabled ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground/50',
          )}
        />
        <span
          className={cn(
            'flex-1 text-sm font-medium transition-colors',
            !enabled && 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          className="scale-[0.85] origin-right"
        />
      </div>
      {enabled && children}
    </div>
  );
}

// ─── Grouped provider+model select ───
interface SelectGroupData {
  groupId: string;
  groupName: string;
  groupIcon?: string;
  items: Array<{ id: string; name: string }>;
}

function GroupedSelect({
  groups,
  selectedGroupId,
  selectedItemId,
  onSelect,
}: {
  groups: SelectGroupData[];
  selectedGroupId: string;
  selectedItemId: string;
  onSelect: (groupId: string, itemId: string) => void;
}) {
  const composite = `${selectedGroupId}::${selectedItemId}`;
  const selectedGroup = groups.find((g) => g.groupId === selectedGroupId);

  return (
    <Select
      value={composite}
      onValueChange={(v) => {
        const sep = v.indexOf('::');
        if (sep === -1) return;
        onSelect(v.slice(0, sep), v.slice(sep + 2));
      }}
    >
      <SelectTrigger className="h-8 w-full rounded-lg border-border/40 bg-background/80 hover:bg-muted/40 shadow-none text-xs focus:ring-1 focus:ring-ring/30 px-2.5">
        <span className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          {selectedGroup?.groupIcon && (
            <img src={selectedGroup.groupIcon} alt="" className="size-4 rounded-sm shrink-0" />
          )}
          <span className="font-medium truncate">{selectedGroup?.groupName}</span>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-muted-foreground truncate">
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
      <SelectContent>
        {groups.map((group, i) => (
          <Fragment key={`${group.groupId}-${i}`}>
            {i > 0 && <SelectSeparator />}
            <SelectGroup>
              <SelectLabel className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
                {group.groupIcon && (
                  <img src={group.groupIcon} alt="" className="size-3.5 rounded-sm" />
                )}
                {group.groupName}
              </SelectLabel>
              {group.items.map((item) => (
                <SelectItem
                  key={`${group.groupId}::${item.id}`}
                  value={`${group.groupId}::${item.id}`}
                  className="text-xs"
                >
                  {item.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </Fragment>
        ))}
      </SelectContent>
    </Select>
  );
}
