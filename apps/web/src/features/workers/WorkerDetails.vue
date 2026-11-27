<script setup lang="ts">
import {
  Avatar,
  Descriptions,
  DescriptionsItem,
  Modal,
  Space,
  Tag,
  TypographyTitle,
} from 'ant-design-vue';
import type { WorkerDto } from '@digital-worker/contracts';

defineProps<{ worker: WorkerDto; open: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Modal
    :open="open"
    title="数字人详情"
    :footer="null"
    centered
    destroy-on-close
    width="min(520px, calc(100vw - 32px))"
    :z-index="1100"
    @cancel="emit('close')"
  >
    <div class="worker-details">
      <div class="worker-details-identity">
        <Avatar :size="40" shape="square" class="directory-avatar">{{
          worker.name.slice(0, 1)
        }}</Avatar>
        <div>
          <TypographyTitle :level="5">{{ worker.name }}</TypographyTitle>
          <div class="worker-details-role">{{ worker.role }}</div>
        </div>
      </div>
      <p>{{ worker.description }}</p>
      <Descriptions size="small" :column="1">
        <DescriptionsItem label="模型">{{ worker.modelName }}</DescriptionsItem>
        <DescriptionsItem label="技能">
          <Space wrap :size="[0, 4]">
            <Tag v-for="skill in worker.skills" :key="skill.id">{{ skill.name }}</Tag>
            <span v-if="!worker.skills.length">未绑定</span>
          </Space>
        </DescriptionsItem>
        <DescriptionsItem label="工具">{{ worker.tools.join('、') || '未绑定' }}</DescriptionsItem>
      </Descriptions>
    </div>
  </Modal>
</template>
