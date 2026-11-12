import { Container } from '../Container';
import { canUseVisibilityFastPath } from '../utils/canUseVisibilityFastPath';
import { updateRenderGroupTransforms } from '../utils/updateRenderGroupTransforms';
import { getWebGLRenderer } from '@test-utils';
import { BlurFilter } from '~/filters/defaults/blur/BlurFilter';
import { Texture } from '~/rendering/renderers/shared/texture/Texture';
import { Graphics } from '~/scene/graphics/shared/Graphics';
import { Sprite } from '~/scene/sprite/Sprite';

import type { BatchableElement } from '~/rendering/batcher/shared/Batcher';
import type { WebGLRenderer } from '~/rendering/renderers/gl/WebGLRenderer';
import type { ViewContainer } from '~/scene/view/ViewContainer';

describe('Visibility fast path', () =>
{
    it('treats a plain batched subtree as eligible', () =>
    {
        const root = new Container({ isRenderGroup: true });
        const wrapper = new Container();
        const sprite = new Sprite(Texture.WHITE);

        wrapper.addChild(sprite);
        root.addChild(wrapper);

        expect(canUseVisibilityFastPath(wrapper)).toBe(true);
    });

    it('falls back to a rebuild when the subtree contains effects, layers or nested render groups', () =>
    {
        const root = new Container({ isRenderGroup: true });

        const filtered = new Container();

        filtered.filters = [new BlurFilter()];
        root.addChild(filtered);
        expect(canUseVisibilityFastPath(filtered)).toBe(false);

        const nested = new Container({ isRenderGroup: true });

        root.addChild(nested);
        expect(canUseVisibilityFastPath(root)).toBe(false);
    });

    it('queues an incremental update instead of a rebuild when a batched child visibility flips', () =>
    {
        const root = new Container({ isRenderGroup: true });
        const wrapper = new Container();
        const sprite = new Sprite(Texture.WHITE);

        wrapper.addChild(sprite);
        root.addChild(wrapper);

        // a real Sprite is updated through its pipe during the transform pass; stub it as there
        // is no renderer in this unit test
        root.renderGroup.instructionSet.renderPipes = {
            sprite: { updateRenderable: jest.fn() },
        };

        root.renderGroup.structureDidChange = false;

        wrapper.visible = false;

        expect(root.renderGroup.structureDidChange).toBe(false);
        expect(root.renderGroup.childrenDisplayStatusToUpdate.index).toBe(1);

        // visibility still propagates through the transform system exactly as before
        updateRenderGroupTransforms(root.renderGroup, true);
        expect(sprite.globalDisplayStatus).toBeLessThan(0b111);

        wrapper.visible = true;
        updateRenderGroupTransforms(root.renderGroup, true);
        expect(sprite.globalDisplayStatus).toBe(0b111);
    });

    it('mutes and restores batched elements in place without rebuilding the instruction set', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;

        const root = new Container({ isRenderGroup: true });
        const wrapper = new Container();
        const sprite = new Sprite(Texture.WHITE);

        wrapper.addChild(sprite);
        root.addChild(wrapper);

        // initial full build
        renderer.render(root);

        const instructionSet = root.renderGroup.instructionSet;
        const instructionCount = instructionSet.instructionSize;

        const getBatchable = () =>
        {
            const data = (sprite as ViewContainer)._gpuData[renderer.uid] as unknown as BatchableElement;

            return data;
        };

        // hide through the fast path
        root.renderGroup.structureDidChange = false;
        wrapper.visible = false;
        renderer.render(root);

        const hiddenBatchable = getBatchable();

        expect(root.renderGroup.structureDidChange).toBe(false);
        // the instruction set is untouched
        expect(instructionSet.instructionSize).toBe(instructionCount);
        expect(hiddenBatchable.visibilityAlpha).toBe(0);

        // show again through the fast path
        wrapper.visible = true;
        renderer.render(root);

        expect(root.renderGroup.structureDidChange).toBe(false);
        expect(instructionSet.instructionSize).toBe(instructionCount);
        expect(getBatchable().visibilityAlpha).toBe(1);

        renderer.destroy();
    });

    it('does not invalidate the local bounds cache on a pure visibility flip', () =>
    {
        const root = new Container({ isRenderGroup: true });
        const sprite = new Sprite(Texture.WHITE);

        root.addChild(sprite);

        // prime the cache
        const first = root.getLocalBounds();

        expect(first).toBe(root.getLocalBounds());

        root.renderGroup.structureDidChange = false;
        sprite.visible = false;

        // the flip is incremental and the cached bounds object is reused until queried again
        expect(sprite._didContainerChangeTick).toBe(0);
        expect(sprite._didVisibilityChangeTick).toBe(1);
    });

    it('recomputes local bounds lazily after a visibility change is queried', () =>
    {
        const root = new Container({ isRenderGroup: true });
        const wrapper = new Container();
        const sprite = new Sprite(Texture.WHITE);

        wrapper.addChild(sprite);
        root.addChild(wrapper);

        const visibleBounds = root.getLocalBounds();

        expect(visibleBounds.isValid).toBe(true);

        wrapper.visible = false;

        const hiddenBounds = root.getLocalBounds();

        // a fully hidden subtree contributes no geometry
        expect(hiddenBounds.width + hiddenBounds.height).toBe(0);
    });

    it('forces a rebuild for a non batchable graphics renderable', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;

        const root = new Container({ isRenderGroup: true });
        const graphics = new Graphics();

        // enough points to exceed the batchable threshold, forcing a dedicated draw instruction
        for (let i = 0; i < 200; i++)
        {
            graphics.circle(i, i, 50).fill({ color: 0xff0000 });
        }

        root.addChild(graphics);
        renderer.render(root);

        root.renderGroup.structureDidChange = false;
        graphics.visible = false;

        // non batchable renderables cannot be muted in place, so the legacy rebuild is requested
        expect(root.renderGroup.structureDidChange).toBe(true);
        expect(canUseVisibilityFastPath(graphics)).toBe(false);

        renderer.destroy();
    });

    it('falls back to a rebuild when showing a subtree muted before an intervening rebuild', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;

        const root = new Container({ isRenderGroup: true });
        const wrapper = new Container();
        const sprite = new Sprite(Texture.WHITE);
        const other = new Sprite(Texture.WHITE);

        wrapper.addChild(sprite);
        root.addChild(wrapper);
        root.addChild(other);

        renderer.render(root);

        // 1. hide the wrapper through the fast path while it is still part of the build
        wrapper.visible = false;
        renderer.render(root);
        expect(root.renderGroup.structureDidChange).toBe(false);

        const mutedTick = wrapper._hiddenViaFastPathBuildTick;

        expect(mutedTick).toBe(root.renderGroup.structureBuildTick);

        // 2. an unrelated structural change forces a full rebuild that drops the hidden subtree
        root.removeChild(other);
        renderer.render(root);
        expect(root.renderGroup.structureBuildTick).toBeGreaterThan(mutedTick);

        // 3. showing it now must NOT use the fast path, as the muted elements are no longer batched
        root.renderGroup.structureDidChange = false;
        wrapper.visible = true;
        expect(root.renderGroup.structureDidChange).toBe(true);

        renderer.render(root);

        const batchable = (sprite as ViewContainer)._gpuData[renderer.uid] as unknown as BatchableElement;

        // the rebuild re-collected the sprite and it is fully visible again
        expect(batchable.visibilityAlpha).toBe(1);
        expect(sprite.globalDisplayStatus).toBe(0b111);

        renderer.destroy();
    });

    it('keeps using the fast path when toggling visibility without an intervening rebuild', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;

        const root = new Container({ isRenderGroup: true });
        const sprite = new Sprite(Texture.WHITE);

        root.addChild(sprite);
        renderer.render(root);

        for (let i = 0; i < 3; i++)
        {
            sprite.visible = false;
            renderer.render(root);
            expect(root.renderGroup.structureDidChange).toBe(false);

            sprite.visible = true;
            renderer.render(root);
            expect(root.renderGroup.structureDidChange).toBe(false);
        }

        const batchable = (sprite as ViewContainer)._gpuData[renderer.uid] as unknown as BatchableElement;

        expect(batchable.visibilityAlpha).toBe(1);

        renderer.destroy();
    });
});
