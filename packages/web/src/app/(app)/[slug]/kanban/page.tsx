import type { Metadata } from 'next'
import KanbanBoardsView from '@/components/console/views/KanbanBoardsView'

export const metadata: Metadata = { title: 'Kanban · AgentConnect' }

export default function Page() {
  return <KanbanBoardsView />
}
