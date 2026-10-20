import type { Metadata } from 'next'
import KanbanBoardView from '@/components/console/views/KanbanBoardView'

export const metadata: Metadata = { title: 'Kanban board · AgentConnect' }

export default function Page() {
  return <KanbanBoardView />
}
