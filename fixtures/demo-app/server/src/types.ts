export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

export interface CreateTodoBody {
  text: string;
}

export interface UpdateTodoBody {
  text?: string;
  done?: boolean;
}
